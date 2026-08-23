/**
 * The single authority for reconciling our state against Razorpay's. Two
 * callers feed it hints that something may have changed — the webhook route
 * (routes/webhook.ts) and the reconciliation sweep (sweep.ts) — but neither
 * hint is trusted directly: every reconcile call re-fetches the order's
 * payments from Razorpay and applies whatever it finds, so a forged or
 * stale webhook body can never move money on its own.
 *
 * This module also owns the only code path that transitions an attempt to
 * `captured` (`applyCapture`) and the only code path that reverses a capture
 * we can no longer honor (`handleProviderCapture`, the anomaly compensator).
 * executor.ts imports both rather than duplicating them, so there is exactly
 * one way a payment becomes "captured" in this system and exactly one way a
 * stray capture gets refunded.
 */

import type Database from 'better-sqlite3'
import { tx } from './db/index.js'
import { appendLedger } from './ledger.js'
import type { RazorpayClient, RazorpayPayment } from './razorpay-client.js'
import type { AttemptState } from './state-machine.js'
import { StaleTransition, transitionAttempt, transitionSettlement } from './state-machine.js'

type AttemptRow = {
  id: string
  settlement_id: string
  method: string
  state: AttemptState
  receipt: string
  provider_order_id: string | null
  provider_payment_id: string | null
  provider_link_id: string | null
}

type SettlementStateRow = { mandate_id: string; state: string }

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export type ReconcileDeps = {
  db: Database.Database
  razorpay: RazorpayClient
}

export type CaptureTarget = {
  attemptId: string
  /** Current live state of the attempt — the CAS `from` for the transition to
   * `captured`. Callers must have already ruled out a terminal (failed/superseded)
   * attempt state before calling this; applyCapture only moves live attempts. */
  attemptState: AttemptState
  settlementId: string
  mandateId: string
  providerOrderId?: string
}

/**
 * Drives one attempt + its settlement to `captured` inside a single
 * transaction: attempt -> captured, settlement `settling` -> captured,
 * allowance -> consumed, ledger `payment_captured`. The only writer of the
 * `captured` attempt state — both the executor's own happy-path confirmation
 * and reconcile's catch-up path funnel through here, so `one_captured_attempt`
 * (schema.sql) only ever has to reject a genuine race, never a code-path
 * inconsistency.
 *
 * Returns false (never throws on a stale CAS) when a concurrent writer moved
 * the attempt or settlement out from under this call between the caller's
 * anomaly check and this transaction — the caller treats that the same as
 * any other race loss, not a distinct outcome.
 */
export function applyCapture(
  db: Database.Database,
  target: CaptureTarget,
  paymentId: string,
): boolean {
  return tx(db, () => {
    try {
      transitionAttempt(db, target.attemptId, target.attemptState, 'captured')
    } catch (err) {
      if (err instanceof StaleTransition) return false
      throw err
    }
    db.prepare(
      'UPDATE settlement_attempts SET provider_payment_id = ?, updated_at = unixepoch() WHERE id = ?',
    ).run(paymentId, target.attemptId)
    try {
      transitionSettlement(db, target.settlementId, 'settling', 'captured')
    } catch (err) {
      if (err instanceof StaleTransition) return false
      throw err
    }
    db.prepare(`UPDATE allowances SET state = 'consumed' WHERE mandate_id = ?`).run(
      target.mandateId,
    )
    appendLedger(db, {
      event_type: 'payment_captured',
      settlement_id: target.settlementId,
      actor: 'facilitator',
      payload: {
        attempt_id: target.attemptId,
        ...(target.providerOrderId ? { provider_order_id: target.providerOrderId } : {}),
        provider_payment_id: paymentId,
      },
    })
    return true
  })
}

/** True once this exact (settlement, payment) pair already has an anomaly
 * refund on the ledger — mirrors the idempotency-key dedup pattern in
 * idempotency.ts so a replayed webhook or a repeat sweep tick never issues a
 * second refund for the same stray capture. */
function alreadyRefunded(db: Database.Database, settlementId: string, paymentId: string): boolean {
  return (
    db
      .prepare(
        `SELECT payload FROM ledger_events WHERE event_type = 'anomaly_refund_issued' AND settlement_id = ?`,
      )
      .all(settlementId) as { payload: string }[]
  ).some((row) => (JSON.parse(row.payload) as { payment_id?: string }).payment_id === paymentId)
}

/**
 * Refunds a capture that can no longer be honored as a live settlement and
 * records the anomaly. Never throws — a stuck refund is a reconciliation
 * job's problem (it stays flagged on the ledger for a human), not a reason
 * to retry-storm the provider from inside a webhook request or a sweep tick.
 */
async function refundAnomalyCapture(
  deps: ReconcileDeps,
  settlementId: string,
  attemptId: string,
  paymentId: string,
): Promise<boolean> {
  const { db, razorpay } = deps
  if (alreadyRefunded(db, settlementId, paymentId)) return true

  try {
    const refund = await razorpay.refundPayment({
      paymentId,
      idempotencyKey: `refund-${attemptId}-${paymentId}`,
    })
    tx(db, () => {
      appendLedger(db, {
        event_type: 'anomaly_refund_issued',
        settlement_id: settlementId,
        actor: 'facilitator',
        payload: { attempt_id: attemptId, payment_id: paymentId, refund_id: refund.id },
      })
    })
    return true
  } catch (err) {
    tx(db, () => {
      appendLedger(db, {
        event_type: 'reconciliation_flagged',
        settlement_id: settlementId,
        actor: 'facilitator',
        payload: {
          reason: 'refund_api_error',
          attempt_id: attemptId,
          payment_id: paymentId,
          detail: errMessage(err),
        },
      })
    })
    return false
  }
}

export type ProviderCaptureEvent = { orderId?: string; paymentId?: string }

/**
 * Reconciles a capture notification (webhook or sweep) against our own
 * settlement state, for the two paths where money moved that our state
 * machine didn't expect: a capture landing after the settlement already went
 * terminal (a crash or timeout mid-attempt, with the provider completing it
 * late), or a second capture racing in when a captured attempt already
 * exists for that settlement, or a capture for an attempt this process
 * already gave up on (marked `failed`/`superseded`) — a terminal attempt can
 * never become the settlement's captured attempt retroactively, so any
 * capture that lands for one is unconditionally an anomaly. A capture for
 * the attempt this executor is actively driving (still `initiated` or
 * `awaiting_confirmation`, settlement still `settling`, no other attempt
 * captured) is a normal confirmation and isn't this function's concern —
 * reconcileByOrder applies that one via `applyCapture`, not here.
 */
export async function handleProviderCapture(
  deps: ReconcileDeps,
  event: ProviderCaptureEvent,
): Promise<void> {
  const { db } = deps

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

  if (attempt.state === 'captured') return

  const settlement = db
    .prepare('SELECT mandate_id, state FROM settlements WHERE id = ?')
    .get(attempt.settlement_id) as SettlementStateRow | undefined
  const existingCaptured = db
    .prepare(`SELECT id FROM settlement_attempts WHERE settlement_id = ? AND state = 'captured'`)
    .get(attempt.settlement_id) as { id: string } | undefined

  const attemptIsLive = attempt.state === 'initiated' || attempt.state === 'awaiting_confirmation'
  const isAnomaly =
    !attemptIsLive || settlement?.state !== 'settling' || existingCaptured !== undefined
  if (!isAnomaly) return

  await refundAnomalyCapture(deps, attempt.settlement_id, attempt.id, paymentId)
}

export type ReconcileOutcome =
  | { kind: 'no_op' }
  | { kind: 'not_found' }
  | { kind: 'captured'; attemptId: string; paymentId: string }
  | { kind: 'failed'; attemptId: string }
  | { kind: 'anomaly_refunded' }
  | { kind: 'reconciliation_flagged' }

/** The captured branch of reconcileByOrder: applies the truth for one attempt whose
 * provider-reported status is `captured`, choosing between the normal capture path
 * and the anomaly compensator based on the same live-attempt / single-captured-attempt
 * check handleProviderCapture uses. */
async function reconcileCapturedPayment(
  deps: ReconcileDeps,
  attempt: AttemptRow,
  paymentId: string,
  providerOrderId: string,
): Promise<ReconcileOutcome> {
  const { db } = deps
  if (attempt.state === 'captured') return { kind: 'no_op' }

  const settlement = db
    .prepare('SELECT mandate_id, state FROM settlements WHERE id = ?')
    .get(attempt.settlement_id) as SettlementStateRow | undefined
  const existingCaptured = db
    .prepare(`SELECT id FROM settlement_attempts WHERE settlement_id = ? AND state = 'captured'`)
    .get(attempt.settlement_id) as { id: string } | undefined

  const attemptIsLive = attempt.state === 'initiated' || attempt.state === 'awaiting_confirmation'
  const isAnomaly =
    !attemptIsLive || settlement?.state !== 'settling' || existingCaptured !== undefined

  if (!isAnomaly && settlement) {
    const applied = applyCapture(
      db,
      {
        attemptId: attempt.id,
        attemptState: attempt.state,
        settlementId: attempt.settlement_id,
        mandateId: settlement.mandate_id,
        providerOrderId,
      },
      paymentId,
    )
    if (applied) return { kind: 'captured', attemptId: attempt.id, paymentId }
    // Lost a race between the read above and applyCapture's own CAS — another
    // writer (the executor, or a concurrent reconcile call) got there first.
    // Falling through to the compensator is safe: refundAnomalyCapture no-ops
    // once the ledger already shows this payment refunded or captured.
  }

  const refunded = await refundAnomalyCapture(deps, attempt.settlement_id, attempt.id, paymentId)
  return refunded ? { kind: 'anomaly_refunded' } : { kind: 'reconciliation_flagged' }
}

function failAttemptIfLive(db: Database.Database, attempt: AttemptRow): ReconcileOutcome {
  if (attempt.state !== 'initiated' && attempt.state !== 'awaiting_confirmation') {
    return { kind: 'no_op' }
  }
  const applied = tx(db, () => {
    try {
      transitionAttempt(db, attempt.id, attempt.state, 'failed')
    } catch (err) {
      if (err instanceof StaleTransition) return false
      throw err
    }
    appendLedger(db, {
      event_type: 'payment_failed',
      settlement_id: attempt.settlement_id,
      actor: 'facilitator',
      payload: { attempt_id: attempt.id, reason: 'reconcile_authoritative_failed' },
    })
    return true
  })
  return applied ? { kind: 'failed', attemptId: attempt.id } : { kind: 'no_op' }
}

/**
 * Fetches the authoritative payment list for `providerOrderId` and converges
 * our attempt row to match: a captured payment drives the normal capture
 * transition (or the anomaly compensator, if this attempt can no longer
 * represent the winning capture); a failed payment fails the attempt if it's
 * still live. No terminal payment yet (or the fetch itself errors) is a
 * no-op — the caller (the sweep) will simply see the attempt as still stale
 * on its next tick and try again.
 */
export async function reconcileByOrder(
  deps: ReconcileDeps,
  providerOrderId: string,
): Promise<ReconcileOutcome> {
  const { db, razorpay } = deps
  const attempt = db
    .prepare('SELECT * FROM settlement_attempts WHERE provider_order_id = ?')
    .get(providerOrderId) as AttemptRow | undefined
  if (!attempt) return { kind: 'not_found' }

  let payments: RazorpayPayment[]
  try {
    payments = await razorpay.fetchOrderPayments(providerOrderId)
  } catch (err) {
    tx(db, () => {
      appendLedger(db, {
        event_type: 'reconciliation_flagged',
        settlement_id: attempt.settlement_id,
        actor: 'facilitator',
        payload: {
          reason: 'fetch_order_payments_failed',
          provider_order_id: providerOrderId,
          detail: errMessage(err),
        },
      })
    })
    return { kind: 'no_op' }
  }

  const latest = payments.at(-1)
  if (!latest) return { kind: 'no_op' }

  if (latest.status === 'captured') {
    return reconcileCapturedPayment(deps, attempt, latest.id, providerOrderId)
  }
  if (latest.status === 'failed') {
    return failAttemptIfLive(db, attempt)
  }
  return { kind: 'no_op' }
}

/**
 * Convenience wrapper for callers (the sweep) that already hold an attempt
 * id rather than a provider order id. An attempt with no order id yet (a
 * checkout-driver attempt that crashed before order-create) has nothing to
 * poll — the sweep handles that case itself by failing the attempt directly,
 * never through here.
 */
export async function reconcileByAttempt(
  deps: ReconcileDeps,
  attemptId: string,
): Promise<ReconcileOutcome> {
  const attempt = deps.db
    .prepare('SELECT * FROM settlement_attempts WHERE id = ?')
    .get(attemptId) as AttemptRow | undefined
  if (!attempt) return { kind: 'not_found' }
  if (!attempt.provider_order_id) return { kind: 'no_op' }
  return reconcileByOrder(deps, attempt.provider_order_id)
}
