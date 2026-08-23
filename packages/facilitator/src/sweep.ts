/**
 * The reconciliation sweep — the backstop that makes the ledger authoritative
 * even when nothing else fired: a crashed executor, a webhook that never
 * arrived, a human who never decided an approval. It runs a fixed set of
 * idempotent convergence rules on a timer; every rule either drives a row to
 * a terminal/expected state via the same CAS transitions the rest of the
 * facilitator uses, or re-kicks the executor — it never invents provider
 * state itself (only the executor creates orders/attempts).
 *
 * Each rule is independently idempotent: a state-CASing rule naturally
 * no-ops on a second pass once the row has moved (StaleTransition is caught
 * and swallowed), and the one rule whose action doesn't itself change any
 * row (re-kicking a stuck `settling` settlement) dedups its own ledger
 * write against ledger history so a busy sweep loop doesn't spam
 * `reconciliation_flagged` rows for the same stuck settlement.
 */

import type Database from 'better-sqlite3'
import { tx } from './db/index.js'
import type { Executor } from './executor.js'
import { appendLedger, type LedgerEventType } from './ledger.js'
import { getMandateRow, intentFromRow } from './mandate-repo.js'
import type { RazorpayClient } from './razorpay-client.js'
import { reconcileByAttempt } from './reconcile.js'
import type { AttemptState, SettlementState } from './state-machine.js'
import { StaleTransition, transitionAttempt, transitionSettlement } from './state-machine.js'

export type SweepTTLs = {
  /** How long a checkout_driver/payment_link attempt can sit `initiated` or
   * `awaiting_confirmation` before the sweep polls Razorpay for its authoritative
   * status (or, for a checkout_driver attempt with no order yet, gives up on it). */
  attemptStaleMs: number
  /** How long a settlement can sit `created`/`verifying` — states normally crossed
   * synchronously within one request — before it's treated as a stranded transient. */
  transientStaleMs: number
  /** How long a settlement can sit `verified` (auto-approved but the caller never
   * followed up with a settle) before it's abandoned. */
  verifiedStaleMs: number
  /** Fixed cap on a `pending_approval` settlement's wait for a human decision,
   * further capped by the mandate's own expires_at (mirrors POST /approvals). */
  approvalTtlMs: number
  /** How long a settlement can sit `approved` before the sweep suspects the kick
   * that should have moved it into `settling` never landed. */
  approvedStaleMs: number
  /** How long a settlement can sit `settling` with no live attempt before the sweep
   * suspects the executor died mid-flight and resumes it. */
  settlingNoAttemptStaleMs: number
  /** How long an idempotency-key row can sit locked with no response before the
   * sweep clears it so the original caller's retry can reclaim the key. */
  idempotencyLockStaleMs: number
  /** Re-kicks budget for a stale `approved` settlement before the sweep gives up
   * and abandons it outright. */
  maxApprovedKicks: number
}

export const DEFAULT_SWEEP_TTLS: SweepTTLs = {
  attemptStaleMs: 90_000,
  transientStaleMs: 60_000,
  verifiedStaleMs: 900_000,
  approvalTtlMs: 1_800_000,
  approvedStaleMs: 60_000,
  settlingNoAttemptStaleMs: 60_000,
  idempotencyLockStaleMs: 300_000,
  maxApprovedKicks: 3,
}

export type SweepDeps = {
  razorpay: RazorpayClient
  executor: Pick<Executor, 'execute' | 'resumeSettling'>
  now: () => number
  ttls?: Partial<SweepTTLs>
}

export type SweepReport = {
  attemptsPolled: number
  attemptsFailedNoArtifact: number
  transientsAbandoned: number
  verifiedAbandoned: number
  approvalsExpired: number
  approvedKicked: number
  approvedAbandoned: number
  settlingResumed: number
  idempotencyLocksCleared: number
}

function emptyReport(): SweepReport {
  return {
    attemptsPolled: 0,
    attemptsFailedNoArtifact: 0,
    transientsAbandoned: 0,
    verifiedAbandoned: 0,
    approvalsExpired: 0,
    approvedKicked: 0,
    approvedAbandoned: 0,
    settlingResumed: 0,
    idempotencyLocksCleared: 0,
  }
}

function secondsAgo(now: number, ms: number): number {
  return now - Math.floor(ms / 1000)
}

/** CASes `id` from `from` to `abandoned` and ledgers the reason. Swallows a
 * StaleTransition (the row already moved) the same way every other CAS site in the
 * codebase does — a race loss here just means some other writer got there first. */
function abandonSettlement(
  db: Database.Database,
  id: string,
  from: SettlementState,
  eventType: LedgerEventType,
  reason: string,
): boolean {
  return tx(db, () => {
    try {
      transitionSettlement(db, id, from, 'abandoned')
    } catch (err) {
      if (err instanceof StaleTransition) return false
      throw err
    }
    appendLedger(db, {
      event_type: eventType,
      settlement_id: id,
      actor: 'facilitator',
      payload: { reason },
    })
    return true
  })
}

/**
 * Builds the sweep: `runOnce()` executes every rule below exactly once (the
 * unit tests drive this directly); `start()`/`stop()` wrap it in a
 * `setInterval` for serve.ts. `db` is separate from `deps` because every
 * other multi-arg constructor in this package (createExecutor excepted)
 * takes the db as part of its deps bag — kept split here to match
 * `createSweep({ db, deps, intervalMs })` call sites reading naturally as
 * "the sweep for this db, using these dependencies."
 */
export function createSweep(opts: {
  db: Database.Database
  deps: SweepDeps
  intervalMs?: number
}): { start(): void; stop(): void; runOnce(): Promise<SweepReport> } {
  const { db, deps } = opts
  const ttls: SweepTTLs = { ...DEFAULT_SWEEP_TTLS, ...deps.ttls }
  const intervalMs = opts.intervalMs ?? 12_000
  let timer: ReturnType<typeof setInterval> | undefined

  async function sweepStaleAttempts(report: SweepReport): Promise<void> {
    const cutoff = secondsAgo(deps.now(), ttls.attemptStaleMs)
    const stale = db
      .prepare(
        `SELECT id, settlement_id, state, provider_order_id FROM settlement_attempts
         WHERE state IN ('initiated','awaiting_confirmation') AND created_at < ?`,
      )
      .all(cutoff) as {
      id: string
      settlement_id: string
      state: AttemptState
      provider_order_id: string | null
    }[]

    for (const attempt of stale) {
      if (attempt.provider_order_id) {
        await reconcileByAttempt({ db, razorpay: deps.razorpay }, attempt.id)
        report.attemptsPolled += 1
        continue
      }
      // No provider artifact yet — only a checkout_driver attempt can be in this
      // shape (payment_link attempts are inserted with provider_link_id already
      // set). The sweep never creates orders or attempts itself, only the executor
      // does (see executor.ts's file header) — so a stale attempt with nothing to
      // poll means the process crashed between the write-ahead insert and the
      // order-create call, and the only correct move is to fail it outright.
      if (attempt.state !== 'initiated') continue
      const failedNow = tx(db, () => {
        try {
          transitionAttempt(db, attempt.id, 'initiated', 'failed')
        } catch (err) {
          if (err instanceof StaleTransition) return false
          throw err
        }
        appendLedger(db, {
          event_type: 'payment_failed',
          settlement_id: attempt.settlement_id,
          actor: 'facilitator',
          payload: { attempt_id: attempt.id, reason: 'no_provider_artifact_stale' },
        })
        return true
      })
      if (failedNow) report.attemptsFailedNoArtifact += 1
    }
  }

  function sweepTransientSettlements(report: SweepReport): void {
    const cutoff = secondsAgo(deps.now(), ttls.transientStaleMs)
    const rows = db
      .prepare(
        `SELECT id, state FROM settlements WHERE state IN ('created','verifying') AND created_at < ?`,
      )
      .all(cutoff) as { id: string; state: SettlementState }[]
    for (const row of rows) {
      const abandoned = abandonSettlement(
        db,
        row.id,
        row.state,
        'settlement_abandoned',
        'stranded_transient',
      )
      if (abandoned) report.transientsAbandoned += 1
    }
  }

  function sweepStaleVerified(report: SweepReport): void {
    const cutoff = secondsAgo(deps.now(), ttls.verifiedStaleMs)
    const rows = db
      .prepare(`SELECT id FROM settlements WHERE state = 'verified' AND verified_at < ?`)
      .all(cutoff) as { id: string }[]
    for (const row of rows) {
      const abandoned = abandonSettlement(
        db,
        row.id,
        'verified',
        'settlement_abandoned',
        'verified_timeout',
      )
      if (abandoned) report.verifiedAbandoned += 1
    }
  }

  function sweepExpiredApprovals(report: SweepReport): void {
    const now = deps.now()
    const rows = db
      .prepare(
        `SELECT id, mandate_id, pending_approval_at FROM settlements WHERE state = 'pending_approval'`,
      )
      .all() as { id: string; mandate_id: string; pending_approval_at: number }[]
    for (const row of rows) {
      const mandateRow = getMandateRow(db, row.mandate_id)
      if (!mandateRow) continue
      const intent = intentFromRow(mandateRow)
      const fixedExpiry = row.pending_approval_at + Math.floor(ttls.approvalTtlMs / 1000)
      const expiresAt = Math.min(fixedExpiry, intent.expires_at)
      if (now <= expiresAt) continue
      const abandoned = abandonSettlement(
        db,
        row.id,
        'pending_approval',
        'approval_expired',
        'approval_timeout',
      )
      if (abandoned) report.approvalsExpired += 1
    }
  }

  function sweepStaleApproved(report: SweepReport): void {
    const now = deps.now()
    const cutoff = secondsAgo(now, ttls.approvedStaleMs)
    const rows = db
      .prepare(
        `SELECT id, mandate_id, kick_count FROM settlements WHERE state = 'approved' AND approved_at < ?`,
      )
      .all(cutoff) as { id: string; mandate_id: string; kick_count: number }[]
    for (const row of rows) {
      const mandateRow = getMandateRow(db, row.mandate_id)
      const intent = mandateRow ? intentFromRow(mandateRow) : undefined
      const mandateExpired = intent !== undefined && now > intent.expires_at

      if (mandateExpired || row.kick_count >= ttls.maxApprovedKicks) {
        const abandoned = abandonSettlement(
          db,
          row.id,
          'approved',
          'settlement_abandoned',
          mandateExpired ? 'mandate_expired' : 'kick_limit_exceeded',
        )
        if (abandoned) report.approvedAbandoned += 1
        continue
      }

      const bumped = db
        .prepare(
          `UPDATE settlements SET kick_count = kick_count + 1 WHERE id = ? AND state = 'approved'`,
        )
        .run(row.id)
      if (bumped.changes === 0) continue // lost the race — someone else already moved it
      deps.executor.execute(row.id)
      report.approvedKicked += 1
    }
  }

  function reconciliationFlaggedFor(settlementId: string, reason: string): boolean {
    return (
      db
        .prepare(
          `SELECT payload FROM ledger_events WHERE event_type = 'reconciliation_flagged' AND settlement_id = ?`,
        )
        .all(settlementId) as { payload: string }[]
    ).some((r) => (JSON.parse(r.payload) as { reason?: string }).reason === reason)
  }

  function sweepStuckSettling(report: SweepReport): void {
    const cutoff = secondsAgo(deps.now(), ttls.settlingNoAttemptStaleMs)
    const rows = db
      .prepare(`SELECT id FROM settlements WHERE state = 'settling' AND settling_at < ?`)
      .all(cutoff) as { id: string }[]
    for (const row of rows) {
      const active = db
        .prepare(
          `SELECT 1 FROM settlement_attempts WHERE settlement_id = ? AND state IN ('initiated','awaiting_confirmation')`,
        )
        .get(row.id)
      if (active) continue

      // Dedup the ledger write only — resumeSettling itself is cheap to call
      // repeatedly (the executor's own inFlight set no-ops a kick already queued),
      // but without this check a settlement stuck across many sweep ticks would
      // accumulate one reconciliation_flagged row per tick.
      if (!reconciliationFlaggedFor(row.id, 'settling_no_active_attempt')) {
        tx(db, () => {
          appendLedger(db, {
            event_type: 'reconciliation_flagged',
            settlement_id: row.id,
            actor: 'facilitator',
            payload: { reason: 'settling_no_active_attempt' },
          })
        })
      }
      deps.executor.resumeSettling(row.id)
      report.settlingResumed += 1
    }
  }

  function sweepStaleIdempotencyLocks(report: SweepReport): void {
    const cutoff = secondsAgo(deps.now(), ttls.idempotencyLockStaleMs)
    const result = db
      .prepare(`DELETE FROM idempotency_keys WHERE response_status IS NULL AND locked_at < ?`)
      .run(cutoff)
    report.idempotencyLocksCleared += result.changes
  }

  async function runOnce(): Promise<SweepReport> {
    const report = emptyReport()
    await sweepStaleAttempts(report)
    sweepTransientSettlements(report)
    sweepStaleVerified(report)
    sweepExpiredApprovals(report)
    sweepStaleApproved(report)
    sweepStuckSettling(report)
    sweepStaleIdempotencyLocks(report)
    return report
  }

  return {
    start(): void {
      if (timer) return
      timer = setInterval(() => {
        runOnce().catch((err) => {
          console.error('sweep: unhandled error', err)
        })
      }, intervalMs)
      timer.unref?.()
    },
    stop(): void {
      if (!timer) return
      clearInterval(timer)
      timer = undefined
    },
    runOnce,
  }
}
