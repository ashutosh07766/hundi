import type { Hono } from 'hono'
import type { AppDeps } from '../app.js'
import { tx } from '../db/index.js'
import { RouteError } from '../errors.js'
import { appendLedger } from '../ledger.js'
import { requireHeaderToken } from '../middleware.js'
import { RazorpayApiError } from '../razorpay-client.js'

/** Best-effort human-readable reason out of a Razorpay error envelope
 * (`{ error: { description } }`), falling back to the raw message. */
function providerErrorDetail(err: RazorpayApiError): string {
  const body = err.body
  if (body && typeof body === 'object' && 'error' in body) {
    const inner = (body as { error?: { description?: unknown } }).error
    if (inner && typeof inner.description === 'string') return inner.description
  }
  return err.message
}

type SettlementStateRow = { id: string; state: string; amount_paise: number }
type CapturedAttemptRow = { id: string; provider_payment_id: string | null }
type RefundLedgerPayload = {
  attempt_id: string
  payment_id: string
  refund_id: string
  amount_paise: number
}

/** True once this settlement already carries a `refund_issued` ledger event — a
 * settlement is captured-terminal (no further state transition exists for it in
 * state-machine.ts), so "already refunded" can't be read off `settlements.state`
 * the way other idempotency checks in this codebase read off a row's state. The
 * ledger is the record of the reversal instead, mirroring reconcile.ts's own
 * `alreadyRefunded` dedup check for the anomaly-refund path. */
function findIssuedRefund(db: AppDeps['db'], settlementId: string): RefundLedgerPayload | null {
  const row = db
    .prepare(
      `SELECT payload FROM ledger_events WHERE event_type = 'refund_issued' AND settlement_id = ? LIMIT 1`,
    )
    .get(settlementId) as { payload: string } | undefined
  return row ? (JSON.parse(row.payload) as RefundLedgerPayload) : null
}

/**
 * POST /settlements/:id/refund — a human decision made from the dashboard,
 * gated by the dashboard token exactly like ceremony-token minting. This is
 * deliberately the ONLY refund entry point an agent-facing surface can never
 * reach: the MCP server holds no dashboard token and no tool here ever calls
 * this route (see packages/mcp-server/src/__tests__/structural.test.ts).
 *
 * Reuses the same RazorpayClient the executor's anomaly compensator uses
 * (razorpay-client.ts, reconcile.ts) — refunding a live purchase and
 * reversing a stray capture are two different triggers for the same
 * provider call, not two different clients.
 */
export function registerRefundRoutes(app: Hono, { db, razorpay, env }: AppDeps): void {
  app.post(
    '/settlements/:id/refund',
    requireHeaderToken('x-hundi-dashboard-token', env.DASHBOARD_TOKEN),
    async (c) => {
      const id = c.req.param('id')

      const settlement = db
        .prepare('SELECT id, state, amount_paise FROM settlements WHERE id = ?')
        .get(id) as SettlementStateRow | undefined
      if (!settlement) throw new RouteError(404, 'SETTLEMENT_NOT_FOUND')

      // Idempotent replay first: a settlement stays 'captured' forever after a
      // refund (no 'refunded' state exists in state-machine.ts), so a retried
      // dashboard click or a double submit must short-circuit here rather than
      // fall through to the state check below and refund a second time.
      const issued = findIssuedRefund(db, id)
      if (issued) {
        return c.json(
          {
            ok: true,
            settlement_id: id,
            refund_id: issued.refund_id,
            amount_paise: issued.amount_paise,
          },
          200,
        )
      }

      if (settlement.state !== 'captured') {
        throw new RouteError(409, 'SETTLEMENT_NOT_CAPTURED')
      }

      const attempt = db
        .prepare(
          `SELECT id, provider_payment_id FROM settlement_attempts WHERE settlement_id = ? AND state = 'captured'`,
        )
        .get(id) as CapturedAttemptRow | undefined
      if (!attempt?.provider_payment_id) {
        throw new RouteError(409, 'NO_CAPTURED_PAYMENT')
      }
      const paymentId = attempt.provider_payment_id

      // The idempotency key makes a retried refund a no-op on Razorpay's side
      // (it replays the original), so this call is safe to reach more than once.
      // A genuine provider failure surfaces as a 502 with the provider's own
      // reason rather than a bare 500 — the refund never wrote to our ledger, so
      // the dashboard can retry once the underlying cause clears.
      let refund: Awaited<ReturnType<typeof razorpay.refundPayment>>
      try {
        refund = await razorpay.refundPayment({
          paymentId,
          idempotencyKey: `refund-${id}-${paymentId}`,
        })
      } catch (err) {
        if (err instanceof RazorpayApiError) {
          throw new RouteError(502, 'REFUND_PROVIDER_ERROR', providerErrorDetail(err))
        }
        throw err
      }

      tx(db, () => {
        appendLedger(db, {
          event_type: 'refund_issued',
          settlement_id: id,
          actor: 'dashboard',
          payload: {
            attempt_id: attempt.id,
            payment_id: paymentId,
            refund_id: refund.id,
            amount_paise: settlement.amount_paise,
          },
        })
      })

      return c.json(
        {
          ok: true,
          settlement_id: id,
          refund_id: refund.id,
          amount_paise: settlement.amount_paise,
        },
        200,
      )
    },
  )
}
