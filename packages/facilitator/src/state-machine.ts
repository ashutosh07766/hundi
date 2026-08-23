import type Database from 'better-sqlite3'

export type SettlementState =
  | 'created'
  | 'verifying'
  | 'verified'
  | 'pending_approval'
  | 'approved'
  | 'settling'
  | 'captured'
  | 'failed'
  | 'rejected'
  | 'abandoned'

export type AttemptState =
  | 'initiated'
  | 'awaiting_confirmation'
  | 'captured'
  | 'failed'
  | 'superseded'

/** Thrown when `to` is not a state `from` is allowed to move to. */
export class InvalidTransition extends Error {
  constructor(from: string, to: string) {
    super(`invalid transition: ${from} -> ${to}`)
    this.name = 'InvalidTransition'
  }
}

/** Thrown when the compare-and-swap `WHERE state = from` matched zero rows — the
 * row moved (or never existed) between read and write. */
export class StaleTransition extends Error {
  constructor(id: string, from: string, to: string) {
    super(`stale transition on ${id}: expected state ${from} to move to ${to}`)
    this.name = 'StaleTransition'
  }
}

export const SETTLEMENT_TRANSITIONS: Record<SettlementState, readonly SettlementState[]> = {
  created: ['verifying'],
  verifying: ['verified', 'rejected'],
  verified: ['pending_approval', 'approved'],
  pending_approval: ['approved', 'rejected', 'abandoned'],
  approved: ['settling', 'rejected', 'abandoned'],
  settling: ['captured', 'failed', 'abandoned'],
  captured: [],
  failed: [],
  rejected: [],
  abandoned: [],
}

export const ATTEMPT_TRANSITIONS: Record<AttemptState, readonly AttemptState[]> = {
  initiated: ['awaiting_confirmation', 'captured', 'failed', 'superseded'],
  awaiting_confirmation: ['captured', 'failed', 'superseded'],
  captured: [],
  failed: [],
  superseded: [],
}

export type TransitionOpts = { rejectReason?: string }

/**
 * Moves `settlements.id` from `from` to `to`. Validates the edge against
 * SETTLEMENT_TRANSITIONS, then performs the write as a compare-and-swap:
 * `WHERE id = ? AND state = ?`. Zero rows updated means the row wasn't in
 * `from` anymore (a concurrent transition beat us) — call sites re-read and
 * retry or surface the conflict rather than assuming success.
 */
export function transitionSettlement(
  db: Database.Database,
  id: string,
  from: SettlementState,
  to: SettlementState,
  opts: TransitionOpts = {},
): void {
  if (!SETTLEMENT_TRANSITIONS[from].includes(to)) {
    throw new InvalidTransition(from, to)
  }
  const timestampColumn = `${to}_at`
  const result = db
    .prepare(
      `UPDATE settlements SET state = ?, ${timestampColumn} = unixepoch(), reject_reason = COALESCE(?, reject_reason) WHERE id = ? AND state = ?`,
    )
    .run(to, opts.rejectReason ?? null, id, from)
  if (result.changes === 0) {
    throw new StaleTransition(id, from, to)
  }
}

/**
 * Moves `settlement_attempts.id` from `from` to `to`. Same CAS discipline as
 * transitionSettlement; attempts have no per-state timestamp columns, so
 * only `updated_at` is bumped.
 */
export function transitionAttempt(
  db: Database.Database,
  id: string,
  from: AttemptState,
  to: AttemptState,
): void {
  if (!ATTEMPT_TRANSITIONS[from].includes(to)) {
    throw new InvalidTransition(from, to)
  }
  const result = db
    .prepare(
      'UPDATE settlement_attempts SET state = ?, updated_at = unixepoch() WHERE id = ? AND state = ?',
    )
    .run(to, id, from)
  if (result.changes === 0) {
    throw new StaleTransition(id, from, to)
  }
}
