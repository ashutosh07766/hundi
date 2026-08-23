/**
 * POST /webhook — Razorpay's push notifications for payment.captured,
 * payment.failed, payment_link.paid, and refund.processed. Treated strictly
 * as a HINT that something may have changed, never as the source of truth:
 * every known event just triggers reconcileByOrder (reconcile.ts), which
 * re-fetches the order's payments from Razorpay before touching any state.
 * A forged or replayed webhook body can therefore never move money on its
 * own — at worst it wastes one reconcile call, which is itself idempotent.
 *
 * Razorpay retries non-2xx responses for 24h, so this handler always
 * responds 200 once the signature checks out, even for an event type it
 * doesn't recognize or can't match to a settlement — the reconciliation
 * sweep (sweep.ts) is the backstop for anything this handler couldn't act
 * on immediately.
 */

import { createHmac, timingSafeEqual } from 'node:crypto'
import type { Hono } from 'hono'
import type { AppDeps } from '../app.js'
import { tx } from '../db/index.js'
import { appendLedger } from '../ledger.js'
import { reconcileByOrder } from '../reconcile.js'

/** Event types that carry a `payment.entity` (or, for payment_link.paid, the payment
 * created behind the link) with an `order_id` we can reconcile against. Any other
 * event type is stored + ledgered but not acted on. */
const RECONCILE_EVENT_TYPES = new Set([
  'payment.captured',
  'payment.failed',
  'payment_link.paid',
  'refund.processed',
])

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Constant-time compare of the raw body's HMAC-SHA256 against the signature header.
 * Must run on the RAW body — re-serializing a parsed object never byte-matches what
 * Razorpay signed. */
function verifySignature(
  rawBody: string,
  signatureHeader: string | undefined,
  secret: string,
): boolean {
  if (!signatureHeader) return false
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex')
  const expectedBuf = Buffer.from(expected, 'utf8')
  const actualBuf = Buffer.from(signatureHeader, 'utf8')
  if (expectedBuf.length !== actualBuf.length) return false
  return timingSafeEqual(expectedBuf, actualBuf)
}

/** Every event type reconciled here nests the underlying payment (order_id included)
 * somewhere in `payload` — payment.captured/failed directly, payment_link.paid because
 * paying a link creates a payment against a Razorpay-managed order, refund.processed
 * because a refund always carries its originating payment. */
function extractOrderId(body: unknown): string | undefined {
  const payload = (body as { payload?: { payment?: { entity?: { order_id?: string } } } })?.payload
  return payload?.payment?.entity?.order_id
}

export function registerWebhookRoutes(app: Hono, { db, env, razorpay }: AppDeps): void {
  app.post('/webhook', async (c) => {
    // Raw text FIRST — signature verification runs before any JSON parsing touches
    // unauthenticated input.
    const rawBody = await c.req.text()
    const signatureHeader = c.req.header('x-razorpay-signature')
    const eventIdHeader = c.req.header('x-razorpay-event-id')

    if (!verifySignature(rawBody, signatureHeader, env.RAZORPAY_WEBHOOK_SECRET)) {
      tx(db, () => {
        appendLedger(db, {
          event_type: 'webhook_rejected',
          actor: 'razorpay',
          payload: { event_id: eventIdHeader ?? 'unknown', reason: 'signature_invalid' },
        })
      })
      return c.json({ ok: false, error: 'WEBHOOK_SIGNATURE_INVALID' }, 400)
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(rawBody)
    } catch {
      tx(db, () => {
        appendLedger(db, {
          event_type: 'webhook_rejected',
          actor: 'razorpay',
          payload: { event_id: eventIdHeader ?? 'unknown', reason: 'invalid_json' },
        })
      })
      return c.json({ ok: false, error: 'WEBHOOK_BODY_INVALID' }, 400)
    }

    if (!eventIdHeader) {
      tx(db, () => {
        appendLedger(db, {
          event_type: 'webhook_rejected',
          actor: 'razorpay',
          payload: { event_id: 'unknown', reason: 'missing_event_id' },
        })
      })
      return c.json({ ok: false, error: 'WEBHOOK_EVENT_ID_MISSING' }, 400)
    }

    const eventType = (parsed as { event?: string }).event ?? 'unknown'

    // Dedup claims the event_id first; only the claimant proceeds to ledger
    // webhook_received and (below) trigger a reconcile — a replayed delivery of the
    // same event_id loses the INSERT OR IGNORE race and stops here, so it can never
    // double-process regardless of what reconcile itself does.
    const dedup = tx(db, () => {
      const result = db
        .prepare(
          'INSERT OR IGNORE INTO webhook_events (event_id, event_type, raw) VALUES (?, ?, ?)',
        )
        .run(eventIdHeader, eventType, rawBody)
      if (result.changes === 0) return { duplicate: true } as const
      appendLedger(db, {
        event_type: 'webhook_received',
        actor: 'razorpay',
        payload: { event_id: eventIdHeader, event: eventType },
      })
      return { duplicate: false } as const
    })
    if (dedup.duplicate) return c.json({ ok: true, duplicate: true }, 200)

    if (RECONCILE_EVENT_TYPES.has(eventType)) {
      const orderId = extractOrderId(parsed)
      if (orderId) {
        try {
          await reconcileByOrder({ db, razorpay }, orderId)
        } catch (err) {
          tx(db, () => {
            appendLedger(db, {
              event_type: 'reconciliation_flagged',
              actor: 'facilitator',
              payload: {
                reason: 'webhook_reconcile_failed',
                event_id: eventIdHeader,
                event: eventType,
                detail: errMessage(err),
              },
            })
          })
        }
      } else {
        tx(db, () => {
          appendLedger(db, {
            event_type: 'reconciliation_flagged',
            actor: 'facilitator',
            payload: {
              reason: 'webhook_missing_order_id',
              event_id: eventIdHeader,
              event: eventType,
            },
          })
        })
      }
    }
    // Unknown event types: already stored (dedup insert) and ledgered
    // (webhook_received) above — nothing further to do, and this is not an error.

    return c.json({ ok: true }, 200)
  })
}
