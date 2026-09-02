import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDb } from '../db/index.js'
import { appendLedger, verifyLedger } from '../ledger.js'

// The event_type CHECK as it stood before 'refund_issued' (and its sibling
// 'anomaly_refund_issued') were added — i.e. the state an older DB file is stuck
// in. CREATE TABLE IF NOT EXISTS never rewrites this, so opening such a file with
// the current code must heal it or every refund append fails the CHECK.
const OLD_LEDGER_SCHEMA = `
CREATE TABLE ledger_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type TEXT NOT NULL CHECK(event_type IN (
    'mandate_registered','mandate_revoked',
    'verify_passed','verify_rejected',
    'approval_requested','approval_granted','approval_rejected','approval_expired',
    'settlement_created',
    'attempt_initiated','attempt_superseded',
    'payment_captured','payment_failed','payment_link_issued',
    'webhook_received','webhook_rejected',
    'reconciliation_flagged',
    'agent_decision',
    'settlement_abandoned'
  )),
  settlement_id TEXT,
  actor TEXT NOT NULL,
  payload TEXT NOT NULL,
  prev_hash TEXT NOT NULL,
  row_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE TRIGGER ledger_events_no_update BEFORE UPDATE ON ledger_events
BEGIN SELECT RAISE(ABORT, 'ledger is append-only'); END;
CREATE TRIGGER ledger_events_no_delete BEFORE DELETE ON ledger_events
BEGIN SELECT RAISE(ABORT, 'ledger is append-only'); END;
`

describe('ledger_events CHECK-heal migration (via openDb)', () => {
  let dir: string
  let path: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'hundi-heal-'))
    path = join(dir, 'old.db')
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('rebuilds a stale CHECK, preserves the hash chain, and admits refund_issued', () => {
    // Seed an old-schema DB with one real chained event, and prove the old CHECK
    // rejects the new event type.
    const old = new Database(path)
    old.exec(OLD_LEDGER_SCHEMA)
    const seeded = appendLedger(old, {
      event_type: 'payment_captured',
      actor: 'executor',
      payload: { n: 1 },
    })
    expect(() =>
      appendLedger(old, { event_type: 'refund_issued', actor: 'dashboard', payload: {} }),
    ).toThrow(/CHECK constraint/)
    old.close()

    // Reopen through openDb — the rebuild migration runs.
    const db = openDb(path)
    const chain = verifyLedger(db)
    expect(chain).toMatchObject({ ok: true, count: 1, head: seeded.row_hash })

    // The previously-rejected event now appends and stays chained (seq continues
    // from the copied row, so the AUTOINCREMENT counter survived the rebuild).
    const refund = appendLedger(db, {
      event_type: 'refund_issued',
      actor: 'dashboard',
      payload: { refund_id: 'rfnd_x' },
    })
    expect(refund.seq).toBe(2)
    expect(verifyLedger(db).ok).toBe(true)
    // Append-only triggers are re-bound to the rebuilt table, not left on the drop.
    expect(() => db.prepare("UPDATE ledger_events SET actor = 'x' WHERE seq = 1").run()).toThrow(
      /append-only/,
    )
    db.close()

    // Idempotent: a second open sees a current CHECK and does not rebuild again.
    const db2 = openDb(path)
    expect(verifyLedger(db2).ok).toBe(true)
    expect(db2.prepare('SELECT COUNT(*) AS c FROM ledger_events').get()).toMatchObject({ c: 2 })
    db2.close()
  })
})
