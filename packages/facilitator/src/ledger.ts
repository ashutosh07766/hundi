import type { CanonicalValue } from '@hundi/core'
import { canonicalJson, sha256Hex } from '@hundi/core'
import type Database from 'better-sqlite3'

export type LedgerEventType =
  | 'mandate_registered'
  | 'mandate_revoked'
  | 'verify_passed'
  | 'verify_rejected'
  | 'approval_requested'
  | 'approval_granted'
  | 'approval_rejected'
  | 'approval_expired'
  | 'settlement_created'
  | 'attempt_initiated'
  | 'attempt_superseded'
  | 'payment_captured'
  | 'payment_failed'
  | 'payment_link_issued'
  | 'anomaly_refund_issued'
  | 'webhook_received'
  | 'webhook_rejected'
  | 'reconciliation_flagged'
  | 'agent_decision'
  | 'settlement_abandoned'

/** Seeds the chain when ledger_events is empty — has no corresponding DB row. */
export const GENESIS_HASH = 'HUNDI_GENESIS'

export type AppendLedgerInput = {
  event_type: LedgerEventType
  settlement_id?: string
  actor: string
  payload: { readonly [key: string]: CanonicalValue }
}

type LedgerRow = {
  seq: number
  event_type: string
  settlement_id: string | null
  actor: string
  payload: string
  prev_hash: string
  row_hash: string
}

function currentHead(db: Database.Database): string {
  const row = db.prepare('SELECT row_hash FROM ledger_events ORDER BY seq DESC LIMIT 1').get() as
    | { row_hash: string }
    | undefined
  return row?.row_hash ?? GENESIS_HASH
}

/**
 * Appends one event to the hash chain. MUST run inside the same transaction
 * as the business write it records — otherwise a crash between the business
 * write and the ledger append leaves state the ledger never accounted for.
 *
 * The payload column stores canonical JSON (not `JSON.stringify`), so
 * verifyLedger's recompute reads back byte-identical bytes to what was
 * hashed at append time.
 */
export function appendLedger(
  db: Database.Database,
  input: AppendLedgerInput,
): { seq: number; row_hash: string } {
  const settlementId = input.settlement_id ?? null
  const prevHash = currentHead(db)
  const rowHash = sha256Hex(
    canonicalJson({
      event_type: input.event_type,
      settlement_id: settlementId,
      actor: input.actor,
      payload: input.payload,
      prev_hash: prevHash,
    }),
  )
  const payloadJson = new TextDecoder().decode(canonicalJson(input.payload))
  const result = db
    .prepare(
      'INSERT INTO ledger_events (event_type, settlement_id, actor, payload, prev_hash, row_hash) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .run(input.event_type, settlementId, input.actor, payloadJson, prevHash, rowHash)
  return { seq: Number(result.lastInsertRowid), row_hash: rowHash }
}

export type VerifyLedgerResult =
  | { ok: true; head: string; count: number }
  | { ok: false; brokenAtSeq: number }

/**
 * Walks the full chain from genesis, recomputing each row_hash from its
 * stored fields and checking it against both the stored row_hash and the
 * previous row's row_hash. Either mismatch means the row (or an earlier
 * one) was altered after being written — the append-only triggers make
 * in-place edits impossible through this process, but do not protect
 * against edits made by a different process with direct file access
 * (e.g. the DB owner rewriting the whole file); see bin/verify-ledger.ts.
 */
export function verifyLedger(db: Database.Database): VerifyLedgerResult {
  const rows = db
    .prepare(
      'SELECT seq, event_type, settlement_id, actor, payload, prev_hash, row_hash FROM ledger_events ORDER BY seq ASC',
    )
    .all() as LedgerRow[]

  let expectedPrev = GENESIS_HASH
  for (const row of rows) {
    if (row.prev_hash !== expectedPrev) {
      return { ok: false, brokenAtSeq: row.seq }
    }
    const payloadValue = JSON.parse(row.payload) as CanonicalValue
    const recomputed = sha256Hex(
      canonicalJson({
        event_type: row.event_type as LedgerEventType,
        settlement_id: row.settlement_id,
        actor: row.actor,
        payload: payloadValue,
        prev_hash: row.prev_hash,
      }),
    )
    if (recomputed !== row.row_hash) {
      return { ok: false, brokenAtSeq: row.seq }
    }
    expectedPrev = row.row_hash
  }
  return { ok: true, head: expectedPrev, count: rows.length }
}
