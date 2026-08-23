import { describe, expect, it } from 'vitest'
import {
  driveSettlementToFailed,
  insertAttempt,
  insertMandate,
  insertSettlement,
  openTestDb,
} from './helpers.js'

// better-sqlite3 puts the SQLite result code on `.code`, not in `.message` — the
// message is the human-readable SQLite text ("UNIQUE constraint failed: ...").
function expectSqliteConstraintViolation(fn: () => void): void {
  expect(fn).toThrow(expect.objectContaining({ code: expect.stringMatching(/^SQLITE_CONSTRAINT/) }))
}

describe('one_active_attempt', () => {
  it('rejects a second initiated attempt for the same settlement', () => {
    const db = openTestDb()
    const settlementId = insertSettlement(db)
    insertAttempt(db, { settlement_id: settlementId, state: 'initiated' })
    expectSqliteConstraintViolation(() =>
      insertAttempt(db, { settlement_id: settlementId, state: 'initiated' }),
    )
  })
})

describe('one_captured_attempt', () => {
  it('rejects a second captured attempt for the same settlement', () => {
    const db = openTestDb()
    const settlementId = insertSettlement(db)
    insertAttempt(db, { settlement_id: settlementId, state: 'captured' })
    expectSqliteConstraintViolation(() =>
      insertAttempt(db, { settlement_id: settlementId, state: 'captured' }),
    )
  })
})

describe('one_live_settlement_per_mandate', () => {
  it('rejects a second non-terminal settlement for the same mandate', () => {
    const db = openTestDb()
    const mandateId = insertMandate(db)
    insertSettlement(db, { mandate_id: mandateId })
    expectSqliteConstraintViolation(() => insertSettlement(db, { mandate_id: mandateId }))
  })

  it('allows a new settlement for the same mandate once the first reaches a terminal state', () => {
    const db = openTestDb()
    const mandateId = insertMandate(db)
    const firstId = insertSettlement(db, { mandate_id: mandateId })
    driveSettlementToFailed(db, firstId)
    expect(() => insertSettlement(db, { mandate_id: mandateId })).not.toThrow()
  })
})

describe('one_settlement_per_cart', () => {
  it('rejects a second live settlement referencing the same mandate_cart_hash_hex', () => {
    const db = openTestDb()
    const cartHash = 'shared-cart-hash'
    insertSettlement(db, { mandate_cart_hash_hex: cartHash })
    // Different mandate so this exercises the cart-hash index specifically, not
    // one_live_settlement_per_mandate.
    const otherMandate = insertMandate(db)
    expectSqliteConstraintViolation(() =>
      insertSettlement(db, { mandate_id: otherMandate, mandate_cart_hash_hex: cartHash }),
    )
  })

  it('allows the same cart hash again once the first settlement fails', () => {
    const db = openTestDb()
    const cartHash = 'retry-cart-hash'
    const firstId = insertSettlement(db, { mandate_cart_hash_hex: cartHash })
    driveSettlementToFailed(db, firstId)
    const otherMandate = insertMandate(db)
    expect(() =>
      insertSettlement(db, { mandate_id: otherMandate, mandate_cart_hash_hex: cartHash }),
    ).not.toThrow()
  })
})

describe('approvals — write-once per settlement', () => {
  it('rejects a second approval row for the same settlement', () => {
    const db = openTestDb()
    const settlementId = insertSettlement(db)
    const insertApproval = db.prepare(
      `INSERT INTO approvals (settlement_id, decision, mandate_cart_hash_hex, sig_json, expires_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    insertApproval.run(settlementId, 'approved', 'cart-hash', '{}', 9_999_999_999)
    expectSqliteConstraintViolation(() =>
      insertApproval.run(settlementId, 'rejected', 'cart-hash', '{}', 9_999_999_999),
    )
  })
})
