/**
 * Brandur-pattern idempotency keys: claim a key by attempting a bare INSERT
 * (the `key` primary key IS the lock — a second concurrent claim collides on
 * it rather than racing a read-then-write check). The claiming INSERT runs
 * outside the caller's business transaction so the lock is visible to a
 * concurrent request immediately; the caller is responsible for writing the
 * completion (`response_status`/`response_body`) back onto the same row
 * inside its own transaction once the business write commits, so a crash
 * between claim and completion leaves the key "locked & incomplete" rather
 * than replaying a response that was never actually produced.
 */

import type Database from 'better-sqlite3'
import { isSqliteConstraintError } from './errors.js'

export type IdempotencyClaim =
  | { state: 'claimed' }
  | { state: 'hash_mismatch' }
  | { state: 'in_flight' }
  | { state: 'completed'; status: number; body: string }

export function claimIdempotencyKey(
  db: Database.Database,
  key: string,
  requestHashHex: string,
): IdempotencyClaim {
  try {
    db.prepare(
      'INSERT INTO idempotency_keys (key, request_hash_hex, locked_at) VALUES (?, ?, unixepoch())',
    ).run(key, requestHashHex)
    return { state: 'claimed' }
  } catch (err) {
    if (!isSqliteConstraintError(err)) throw err
    const row = db
      .prepare(
        'SELECT request_hash_hex, response_status, response_body FROM idempotency_keys WHERE key = ?',
      )
      .get(key) as
      | { request_hash_hex: string; response_status: number | null; response_body: string | null }
      | undefined
    // The constraint violation proves a row exists; a missing row here would mean a
    // concurrent DELETE, which nothing in this schema ever does.
    if (!row) throw err
    if (row.request_hash_hex !== requestHashHex) return { state: 'hash_mismatch' }
    if (row.response_status === null || row.response_body === null) return { state: 'in_flight' }
    return { state: 'completed', status: row.response_status, body: row.response_body }
  }
}

/** Writes the completion back onto an already-claimed key. Call inside the business tx. */
export function completeIdempotencyKey(
  db: Database.Database,
  key: string,
  settlementId: string | null,
  responseStatus: number,
  responseBody: string,
): void {
  db.prepare(
    'UPDATE idempotency_keys SET settlement_id = ?, response_status = ?, response_body = ? WHERE key = ?',
  ).run(settlementId, responseStatus, responseBody, key)
}
