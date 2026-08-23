import { describe, expect, it } from 'vitest'
import type { AttemptState, SettlementState } from '../state-machine.js'
import {
  ATTEMPT_TRANSITIONS,
  InvalidTransition,
  SETTLEMENT_TRANSITIONS,
  StaleTransition,
  transitionAttempt,
  transitionSettlement,
} from '../state-machine.js'
import { insertSettlement, openTestDb } from './helpers.js'

const ALL_SETTLEMENT_STATES = Object.keys(SETTLEMENT_TRANSITIONS) as SettlementState[]
const ALL_ATTEMPT_STATES = Object.keys(ATTEMPT_TRANSITIONS) as AttemptState[]

// Invalid-edge checks run before any DB query, so a single shared row (never
// actually mutated by a rejected transition) is safe to reuse across the
// whole matrix.
describe('transitionSettlement — full disallowed-edge matrix', () => {
  const db = openTestDb()
  const id = insertSettlement(db)

  for (const from of ALL_SETTLEMENT_STATES) {
    for (const to of ALL_SETTLEMENT_STATES) {
      if (SETTLEMENT_TRANSITIONS[from].includes(to)) continue
      it(`${from} -> ${to} throws InvalidTransition`, () => {
        expect(() => transitionSettlement(db, id, from, to)).toThrow(InvalidTransition)
      })
    }
  }
})

describe('transitionAttempt — full disallowed-edge matrix', () => {
  const db = openTestDb()
  const id = 'attempt-matrix' // no real row needed: invalid edges throw before the query runs

  for (const from of ALL_ATTEMPT_STATES) {
    for (const to of ALL_ATTEMPT_STATES) {
      if (ATTEMPT_TRANSITIONS[from].includes(to)) continue
      it(`${from} -> ${to} throws InvalidTransition`, () => {
        expect(() => transitionAttempt(db, id, from, to)).toThrow(InvalidTransition)
      })
    }
  }
})

describe('transitionSettlement — compare-and-swap', () => {
  it('applies a valid transition and stamps the state timestamp', () => {
    const db = openTestDb()
    const id = insertSettlement(db)
    transitionSettlement(db, id, 'created', 'verifying')
    const row = db.prepare('SELECT state, verifying_at FROM settlements WHERE id = ?').get(id) as {
      state: string
      verifying_at: number | null
    }
    expect(row.state).toBe('verifying')
    expect(row.verifying_at).not.toBeNull()
  })

  it('throws StaleTransition when the row has already moved past `from`', () => {
    const db = openTestDb()
    const id = insertSettlement(db)
    transitionSettlement(db, id, 'created', 'verifying')
    expect(() => transitionSettlement(db, id, 'created', 'verifying')).toThrow(StaleTransition)
  })

  it('a second sequential transition fails once its `from` is stale, even for a valid edge', () => {
    const db = openTestDb()
    const id = insertSettlement(db)
    transitionSettlement(db, id, 'created', 'verifying')
    transitionSettlement(db, id, 'verifying', 'verified')
    // Row is now 'verified'. 'verifying' -> 'rejected' is a valid edge in the table,
    // but this row isn't in 'verifying' anymore, so the CAS must still fail.
    expect(() => transitionSettlement(db, id, 'verifying', 'rejected')).toThrow(StaleTransition)
  })

  it('rejects carries a reject_reason', () => {
    const db = openTestDb()
    const id = insertSettlement(db)
    transitionSettlement(db, id, 'created', 'verifying')
    transitionSettlement(db, id, 'verifying', 'rejected', { rejectReason: 'signature_invalid' })
    const row = db.prepare('SELECT state, reject_reason FROM settlements WHERE id = ?').get(id) as {
      state: string
      reject_reason: string | null
    }
    expect(row.state).toBe('rejected')
    expect(row.reject_reason).toBe('signature_invalid')
  })
})
