import { describe, expect, it } from 'vitest'
import { appendLedger, GENESIS_HASH, verifyLedger } from '../ledger.js'
import { openTestDb } from './helpers.js'

describe('ledger_events — append-only triggers', () => {
  it('raises on UPDATE', () => {
    const db = openTestDb()
    appendLedger(db, { event_type: 'settlement_created', actor: 'test', payload: {} })
    expect(() =>
      db.prepare("UPDATE ledger_events SET actor = 'tampered' WHERE seq = 1").run(),
    ).toThrow(/ledger is append-only/)
  })

  it('raises on DELETE', () => {
    const db = openTestDb()
    appendLedger(db, { event_type: 'settlement_created', actor: 'test', payload: {} })
    expect(() => db.prepare('DELETE FROM ledger_events WHERE seq = 1').run()).toThrow(
      /ledger is append-only/,
    )
  })
})

describe('appendLedger + verifyLedger', () => {
  it('an empty ledger verifies as genesis with zero events', () => {
    const db = openTestDb()
    expect(verifyLedger(db)).toEqual({ ok: true, head: GENESIS_HASH, count: 0 })
  })

  it('a chain of 5 events verifies clean from genesis', () => {
    const db = openTestDb()
    let lastRowHash = ''
    for (let i = 0; i < 5; i++) {
      const { row_hash } = appendLedger(db, {
        event_type: 'agent_decision',
        actor: 'agent',
        payload: { i },
      })
      lastRowHash = row_hash
    }
    const result = verifyLedger(db)
    expect(result).toEqual({ ok: true, head: lastRowHash, count: 5 })
  })

  it('detects a hand-corrupted row', () => {
    const db = openTestDb()
    for (let i = 0; i < 5; i++) {
      appendLedger(db, { event_type: 'agent_decision', actor: 'agent', payload: { i } })
    }
    // The append-only trigger blocks this at the SQL layer under normal operation;
    // dropping it here simulates tampering from outside this process (e.g. direct
    // file access) to prove verifyLedger catches what the trigger can't.
    db.exec('DROP TRIGGER ledger_events_no_update')
    db.prepare('UPDATE ledger_events SET payload = ? WHERE seq = 3').run('{"i":999}')
    db.exec(
      `CREATE TRIGGER ledger_events_no_update BEFORE UPDATE ON ledger_events BEGIN SELECT RAISE(ABORT, 'ledger is append-only'); END;`,
    )

    expect(verifyLedger(db)).toEqual({ ok: false, brokenAtSeq: 3 })
  })
})
