/**
 * Seam between the HTTP surface and settlement execution, and the only code
 * that moves money. Routes call `execute()` after committing an `approved`
 * state transition — it is a fire-and-forget kick (no return value, no
 * awaited completion) so the HTTP response is never blocked on a payment
 * attempt.
 *
 * `createExecutor` serializes every settle behind a single in-process
 * promise chain: the checkout driver drives one real browser, so there is
 * never more than one attempt in flight process-wide, and a second kick for
 * an id already being processed is a no-op rather than a duplicate run.
 *
 * better-sqlite3 transactions (`tx()`) run synchronously — network calls
 * (order creation, the checkout drive, refunds) always happen *outside* a
 * `tx()` block, with the surrounding DB writes split into separate
 * transactions before and after the call. This is why attempt rows are
 * written write-ahead (before the network call that might time out) rather
 * than after: a crash mid-attempt still leaves a durable record that an
 * attempt was made.
 */

import { randomUUID } from 'node:crypto'
import type { CartMandate } from '@hundi/core'
import { verifyChain } from '@hundi/core'
import type Database from 'better-sqlite3'
import { tx } from './db/index.js'
import type { Env } from './env.js'
import { appendLedger } from './ledger.js'
import { getMandateRow, intentFromRow } from './mandate-repo.js'
import type { SettleViaCheckoutResult } from './rails/checkout-driver.js'
import type { RazorpayClient, RazorpayPaymentLink } from './razorpay-client.js'
import { createRazorpayClient } from './razorpay-client.js'
import type { AttemptState } from './state-machine.js'
import { StaleTransition, transitionAttempt, transitionSettlement } from './state-machine.js'
import { buildVerifyCtx } from './verify-logic.js'

export interface Executor {
  execute(settlementId: string): void
}

export const noopExecutor: Executor = {
  execute(_settlementId: string): void {
    // Used wherever a real executor hasn't been wired up (tests, the seam
    // before createExecutor existed). See createExecutor for the real thing.
  },
}

const MAX_ATTEMPTS = 3

type SettlementRow = {
  id: string
  mandate_id: string
  cart_json: string
  mandate_cart_hash_hex: string
  amount_paise: number
  merchant_id: string
  state: string
}

type AttemptRow = {
  id: string
  settlement_id: string
  method: string
  state: string
  receipt: string
  provider_order_id: string | null
  provider_payment_id: string | null
  provider_link_id: string | null
}

/** Driver interface the executor depends on — the real checkout driver
 * (rails/checkout-driver.ts) in production, a scripted fake in tests. Kept
 * narrower than `CheckoutDriver` on purpose: the executor never passes
 * `vpa` or `outcome`, so tests don't need to implement or ignore them. */
export interface SettleDriver {
  settleViaCheckout(args: {
    orderId: string
    amountPaise: number
  }): Promise<SettleViaCheckoutResult>
}

export type ExecutionOutcome =
  | { kind: 'no_op' }
  | { kind: 'rejected'; reason: string }
  | { kind: 'captured'; attemptId: string; paymentId: string }
  | { kind: 'payment_link_issued'; attemptId: string; shortUrl: string }
  | { kind: 'stalled' }

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export type RunnerDeps = {
  db: Database.Database
  razorpay: RazorpayClient
  driver: SettleDriver
  now: () => number
}

type ReverifyOutcome =
  | { ok: true; settlement: SettlementRow }
  | { ok: false; reason: 'stale' }
  | { ok: false; reason: 'rejected'; rejectReason: string }

/**
 * Re-runs the full verify chain inside the same tx as the `approved ->
 * settling` CAS. Approval can be minutes old by the time a kick actually
 * runs (queued behind another settle, or a process restart re-kicks a
 * settlement that was `approved` when it crashed) — revocation, expiry, and
 * a corrupted mandate_cart_hash are all real states that can appear in that
 * window and must be caught before any money moves, not just at
 * POST /settlements time.
 */
function reverifyAndEnterSettling(
  db: Database.Database,
  settlementId: string,
  now: number,
): ReverifyOutcome {
  return tx(db, () => {
    const settlement = db
      .prepare(
        `SELECT id, mandate_id, cart_json, mandate_cart_hash_hex, amount_paise, merchant_id, state
         FROM settlements WHERE id = ?`,
      )
      .get(settlementId) as SettlementRow | undefined
    if (settlement?.state !== 'approved') return { ok: false, reason: 'stale' }

    const mandateRow = getMandateRow(db, settlement.mandate_id)
    if (!mandateRow) return { ok: false, reason: 'stale' }
    const intent = intentFromRow(mandateRow)
    const cart = JSON.parse(settlement.cart_json) as CartMandate

    const { ctx, mandateCartHashHex } = buildVerifyCtx(db, intent, cart, now, {
      excludeSettlementId: settlementId,
    })

    const result =
      mandateCartHashHex === settlement.mandate_cart_hash_hex
        ? verifyChain(intent, cart, ctx)
        : ({ ok: false, reason: 'HASH_LINK_MISMATCH' } as const)

    if (!result.ok) {
      try {
        transitionSettlement(db, settlementId, 'approved', 'rejected', {
          rejectReason: result.reason,
        })
      } catch (err) {
        if (err instanceof StaleTransition) return { ok: false, reason: 'stale' }
        throw err
      }
      appendLedger(db, {
        event_type: 'verify_rejected',
        settlement_id: settlementId,
        actor: 'facilitator',
        payload:
          'detail' in result && result.detail !== undefined
            ? { reason: result.reason, detail: result.detail }
            : { reason: result.reason },
      })
      return { ok: false, reason: 'rejected', rejectReason: result.reason }
    }

    try {
      transitionSettlement(db, settlementId, 'approved', 'settling')
    } catch (err) {
      if (err instanceof StaleTransition) return { ok: false, reason: 'stale' }
      throw err
    }
    return { ok: true, settlement }
  })
}

/** Moves an attempt to 'superseded' iff it's still in a non-terminal state — a no-op
 * (not an error) if a previous step already terminated it, which is the common case
 * since every retry-loop failure path already CASes the attempt to 'failed' before
 * this ever runs. */
function supersedeIfActive(db: Database.Database, attemptId: string): void {
  const row = db.prepare('SELECT state FROM settlement_attempts WHERE id = ?').get(attemptId) as
    | { state: AttemptState }
    | undefined
  if (!row) return
  if (row.state !== 'initiated' && row.state !== 'awaiting_confirmation') return
  try {
    transitionAttempt(db, attemptId, row.state, 'superseded')
  } catch (err) {
    if (!(err instanceof StaleTransition)) throw err
  }
}

async function fallbackToPaymentLink(
  deps: RunnerDeps,
  settlementId: string,
  settlement: SettlementRow,
  lastAttemptId: string,
): Promise<ExecutionOutcome> {
  const linkAttemptId = randomUUID()
  const receipt = `settle-${settlementId}-link-${linkAttemptId.slice(0, 8)}`

  let link: RazorpayPaymentLink
  try {
    link = await deps.razorpay.createPaymentLink({
      amountPaise: settlement.amount_paise,
      referenceId: receipt,
    })
  } catch (err) {
    // The fallback itself is best-effort infrastructure, not the record of truth —
    // leave the settlement in `settling` for a human/sweep to retry rather than
    // forcing it to a terminal state over a payment-link API hiccup.
    tx(deps.db, () => {
      appendLedger(deps.db, {
        event_type: 'reconciliation_flagged',
        settlement_id: settlementId,
        actor: 'facilitator',
        payload: { reason: 'payment_link_create_failed', detail: errMessage(err) },
      })
    })
    return { kind: 'stalled' }
  }

  tx(deps.db, () => {
    supersedeIfActive(deps.db, lastAttemptId)
    deps.db
      .prepare(
        `INSERT INTO settlement_attempts (id, settlement_id, method, state, receipt, provider_link_id)
         VALUES (?, ?, 'payment_link', 'awaiting_confirmation', ?, ?)`,
      )
      .run(linkAttemptId, settlementId, receipt, link.id)
    appendLedger(deps.db, {
      event_type: 'payment_link_issued',
      settlement_id: settlementId,
      actor: 'facilitator',
      payload: { attempt_id: linkAttemptId, provider_link_id: link.id, short_url: link.short_url },
    })
  })

  return { kind: 'payment_link_issued', attemptId: linkAttemptId, shortUrl: link.short_url }
}

/**
 * Runs one settle to completion: reverify -> up to MAX_ATTEMPTS checkout-driver
 * attempts -> payment-link fallback. Exported (in addition to the fire-and-forget
 * `Executor.execute`) so tests and the smoke script can await a single run directly
 * instead of polling for the async kick to finish.
 */
export async function runOnce(deps: RunnerDeps, settlementId: string): Promise<ExecutionOutcome> {
  const reverify = reverifyAndEnterSettling(deps.db, settlementId, deps.now())
  if (!reverify.ok) {
    return reverify.reason === 'rejected'
      ? { kind: 'rejected', reason: reverify.rejectReason }
      : { kind: 'no_op' }
  }

  const settlement = reverify.settlement
  let lastAttemptId = ''

  for (let attemptNum = 1; attemptNum <= MAX_ATTEMPTS; attemptNum++) {
    const attemptId = randomUUID()
    lastAttemptId = attemptId
    const receipt = `settle-${settlementId}-${attemptNum}-${attemptId.slice(0, 8)}`

    tx(deps.db, () => {
      deps.db
        .prepare(
          `INSERT INTO settlement_attempts (id, settlement_id, method, state, receipt)
           VALUES (?, ?, 'checkout_driver', 'initiated', ?)`,
        )
        .run(attemptId, settlementId, receipt)
      appendLedger(deps.db, {
        event_type: 'attempt_initiated',
        settlement_id: settlementId,
        actor: 'facilitator',
        payload: { attempt_id: attemptId, method: 'checkout_driver', attempt_num: attemptNum },
      })
    })

    let providerOrderId: string
    try {
      const order = await deps.razorpay.createOrder({
        amountPaise: settlement.amount_paise,
        receipt,
      })
      providerOrderId = order.id
    } catch (err) {
      tx(deps.db, () => {
        transitionAttempt(deps.db, attemptId, 'initiated', 'failed')
        appendLedger(deps.db, {
          event_type: 'payment_failed',
          settlement_id: settlementId,
          actor: 'facilitator',
          payload: {
            attempt_id: attemptId,
            reason: 'order_create_failed',
            detail: errMessage(err),
          },
        })
      })
      continue
    }

    deps.db
      .prepare(
        'UPDATE settlement_attempts SET provider_order_id = ?, updated_at = unixepoch() WHERE id = ?',
      )
      .run(providerOrderId, attemptId)

    const driverResult = await deps.driver.settleViaCheckout({
      orderId: providerOrderId,
      amountPaise: settlement.amount_paise,
    })

    if (driverResult.ok && driverResult.status === 'captured' && driverResult.paymentId) {
      const paymentId = driverResult.paymentId
      let captured = false
      tx(deps.db, () => {
        try {
          transitionAttempt(deps.db, attemptId, 'initiated', 'captured')
        } catch (err) {
          if (err instanceof StaleTransition) return
          throw err
        }
        deps.db
          .prepare(
            'UPDATE settlement_attempts SET provider_payment_id = ?, updated_at = unixepoch() WHERE id = ?',
          )
          .run(paymentId, attemptId)
        // one_captured_attempt + one_live_settlement_per_mandate (schema.sql) are the
        // actual double-capture guards; this transition failing would mean a settlement
        // this executor already holds single-flight on somehow moved out from under it.
        transitionSettlement(deps.db, settlementId, 'settling', 'captured')
        deps.db
          .prepare(`UPDATE allowances SET state = 'consumed' WHERE mandate_id = ?`)
          .run(settlement.mandate_id)
        appendLedger(deps.db, {
          event_type: 'payment_captured',
          settlement_id: settlementId,
          actor: 'facilitator',
          payload: {
            attempt_id: attemptId,
            provider_order_id: providerOrderId,
            provider_payment_id: paymentId,
          },
        })
        captured = true
      })
      if (captured) return { kind: 'captured', attemptId, paymentId }
    }

    tx(deps.db, () => {
      try {
        transitionAttempt(deps.db, attemptId, 'initiated', 'failed')
      } catch (err) {
        if (!(err instanceof StaleTransition)) throw err
      }
      appendLedger(deps.db, {
        event_type: 'payment_failed',
        settlement_id: settlementId,
        actor: 'facilitator',
        payload: {
          attempt_id: attemptId,
          provider_order_id: providerOrderId,
          status: driverResult.status ?? 'error',
          error: driverResult.error ?? 'unknown',
        },
      })
    })
  }

  return fallbackToPaymentLink(deps, settlementId, settlement, lastAttemptId)
}

export type ExecutorDeps = {
  db: Database.Database
  env: Pick<Env, 'RAZORPAY_KEY_ID' | 'RAZORPAY_KEY_SECRET'>
  driver: SettleDriver
  /** Clock override for tests. Defaults to the real wall clock. */
  now?: () => number
  /** RazorpayClient override for tests — lets executor-level tests (concurrency,
   * idempotent kicks) run without a real network call. Production always derives
   * this from `env`. */
  razorpay?: RazorpayClient
}

export interface ExecutorTestHooks {
  /** Resolves once every kick queued so far has finished. Test-only — production
   * callers use the fire-and-forget `execute()` and never await completion. */
  waitForIdle(): Promise<void>
}

/**
 * Builds the real executor. `driver` is injected so production wires the real
 * checkout driver (rails/checkout-driver.ts) while tests wire a scripted fake —
 * the executor itself never imports Playwright.
 */
export function createExecutor(deps: ExecutorDeps): Executor & ExecutorTestHooks {
  const razorpay =
    deps.razorpay ??
    createRazorpayClient({
      keyId: deps.env.RAZORPAY_KEY_ID,
      keySecret: deps.env.RAZORPAY_KEY_SECRET,
    })
  const runnerDeps: RunnerDeps = {
    db: deps.db,
    razorpay,
    driver: deps.driver,
    now: deps.now ?? (() => Math.floor(Date.now() / 1000)),
  }

  // Only one settle in flight process-wide (the checkout driver drives a single
  // real browser) — every kick is chained onto the same promise. Per-id dedup on
  // top means a repeat kick for a settlement already queued/running is a no-op
  // rather than a second entry in the chain.
  const inFlight = new Set<string>()
  let chain: Promise<void> = Promise.resolve()

  return {
    execute(settlementId: string): void {
      if (inFlight.has(settlementId)) return
      inFlight.add(settlementId)
      chain = chain
        .then(() => runOnce(runnerDeps, settlementId))
        .then(
          (outcome) => {
            console.log(JSON.stringify({ event: 'executor_outcome', settlementId, outcome }))
          },
          (err) => {
            console.error(`executor: unhandled error settling ${settlementId}:`, err)
          },
        )
        .finally(() => {
          inFlight.delete(settlementId)
        })
    },
    waitForIdle(): Promise<void> {
      return chain
    },
  }
}

export type ProviderCaptureEvent = { orderId?: string; paymentId?: string }

/**
 * Reconciles a capture notification (webhook or sweep, wired up in U8) against
 * our own settlement state. A capture for the attempt this executor is actively
 * driving is a normal confirmation and isn't this function's concern — this
 * exists for the two paths where money moved that our state machine didn't
 * expect: a capture landing after the settlement already went terminal (a crash
 * or timeout mid-attempt, with the provider completing it late), or a second
 * capture racing in when a captured attempt already exists for that settlement.
 * Both mean Razorpay took the customer's money for something we can no longer
 * honor as a live settlement, so the only correct move is to give it back.
 */
export async function handleProviderCapture(
  deps: { db: Database.Database; razorpay: RazorpayClient },
  event: ProviderCaptureEvent,
): Promise<void> {
  const { db, razorpay } = deps

  const attempt = event.orderId
    ? (db
        .prepare('SELECT * FROM settlement_attempts WHERE provider_order_id = ?')
        .get(event.orderId) as AttemptRow | undefined)
    : (db
        .prepare('SELECT * FROM settlement_attempts WHERE provider_payment_id = ?')
        .get(event.paymentId) as AttemptRow | undefined)

  if (!attempt) {
    tx(db, () => {
      appendLedger(db, {
        event_type: 'reconciliation_flagged',
        actor: 'facilitator',
        payload: { reason: 'capture_for_unknown_attempt', ...event },
      })
    })
    return
  }

  const paymentId = event.paymentId ?? attempt.provider_payment_id ?? undefined
  if (!paymentId) {
    tx(db, () => {
      appendLedger(db, {
        event_type: 'reconciliation_flagged',
        settlement_id: attempt.settlement_id,
        actor: 'facilitator',
        payload: { reason: 'capture_missing_payment_id', attempt_id: attempt.id },
      })
    })
    return
  }

  // This exact capture is already the one this executor recorded — a normal
  // confirming webhook, not an anomaly.
  if (attempt.state === 'captured') return

  const settlement = db
    .prepare('SELECT state FROM settlements WHERE id = ?')
    .get(attempt.settlement_id) as { state: string } | undefined
  const existingCaptured = db
    .prepare(`SELECT id FROM settlement_attempts WHERE settlement_id = ? AND state = 'captured'`)
    .get(attempt.settlement_id) as { id: string } | undefined

  const isAnomaly = settlement?.state !== 'settling' || existingCaptured !== undefined
  if (!isAnomaly) return

  const alreadyRefunded = (
    db
      .prepare(
        `SELECT payload FROM ledger_events WHERE event_type = 'anomaly_refund_issued' AND settlement_id = ?`,
      )
      .all(attempt.settlement_id) as { payload: string }[]
  ).some((row) => (JSON.parse(row.payload) as { payment_id?: string }).payment_id === paymentId)
  if (alreadyRefunded) return

  try {
    const refund = await razorpay.refundPayment({
      paymentId,
      idempotencyKey: `refund-${attempt.id}-${paymentId}`,
    })
    tx(db, () => {
      appendLedger(db, {
        event_type: 'anomaly_refund_issued',
        settlement_id: attempt.settlement_id,
        actor: 'facilitator',
        payload: { attempt_id: attempt.id, payment_id: paymentId, refund_id: refund.id },
      })
    })
  } catch (err) {
    // Do not throw: the caller (a webhook handler) must still ack the delivery, and a
    // stuck refund is a reconciliation job's problem, not a reason to retry-storm the
    // provider from inside a webhook request.
    tx(db, () => {
      appendLedger(db, {
        event_type: 'reconciliation_flagged',
        settlement_id: attempt.settlement_id,
        actor: 'facilitator',
        payload: {
          reason: 'refund_api_error',
          attempt_id: attempt.id,
          payment_id: paymentId,
          detail: errMessage(err),
        },
      })
    })
  }
}
