import { describe, expect, it } from 'vitest'
import { tx } from '../db/index.js'
import { appendLedger } from '../ledger.js'
import { insertMandate, openTestDb } from './helpers.js'

describe('tx()', () => {
  it('rolls back both the ledger append and the business write when the callback throws', () => {
    const db = openTestDb()
    const mandateId = insertMandate(db)

    expect(() =>
      tx(db, () => {
        appendLedger(db, { event_type: 'settlement_created', actor: 'test', payload: {} })
        db.prepare(
          `INSERT INTO settlements (id, mandate_id, cart_json, mandate_cart_hash_hex, amount_paise, merchant_id)
           VALUES (?, ?, ?, ?, ?, ?)`,
        ).run('settlement-atomic', mandateId, '{}', 'cart-hash-atomic', 100, 'merchant-1')
        throw new Error('boom')
      }),
    ).toThrow('boom')

    const ledgerCount = db.prepare('SELECT COUNT(*) AS c FROM ledger_events').get() as { c: number }
    const settlementCount = db
      .prepare('SELECT COUNT(*) AS c FROM settlements WHERE id = ?')
      .get('settlement-atomic') as { c: number }
    expect(ledgerCount.c).toBe(0)
    expect(settlementCount.c).toBe(0)
  })

  it('commits both writes when the callback succeeds', () => {
    const db = openTestDb()
    const mandateId = insertMandate(db)

    tx(db, () => {
      appendLedger(db, { event_type: 'settlement_created', actor: 'test', payload: {} })
      db.prepare(
        `INSERT INTO settlements (id, mandate_id, cart_json, mandate_cart_hash_hex, amount_paise, merchant_id)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run('settlement-committed', mandateId, '{}', 'cart-hash-committed', 100, 'merchant-1')
    })

    const ledgerCount = db.prepare('SELECT COUNT(*) AS c FROM ledger_events').get() as { c: number }
    const settlementCount = db
      .prepare('SELECT COUNT(*) AS c FROM settlements WHERE id = ?')
      .get('settlement-committed') as { c: number }
    expect(ledgerCount.c).toBe(1)
    expect(settlementCount.c).toBe(1)
  })
})
