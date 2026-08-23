import { describe, expect, it } from 'vitest'
import type { SettleDriver } from '../executor.js'
import { createExecutor, handleProviderCapture, runOnce } from '../executor.js'
import { transitionSettlement } from '../state-machine.js'
import {
  baseRunnerDeps,
  captured,
  failed,
  makeApprovedSettlement,
  makeFakeRazorpay,
  makeScriptedDriver,
} from './executor-helpers.js'
import { insertSettlement, openTestDb } from './helpers.js'
import { TEST_ENV } from './http-helpers.js'

// better-sqlite3 puts the SQLite result code on `.code` — see constraints.test.ts.
function expectSqliteConstraintViolation(fn: () => void): void {
  expect(fn).toThrow(expect.objectContaining({ code: expect.stringMatching(/^SQLITE_CONSTRAINT/) }))
}

describe('runOnce — happy path', () => {
  it('captures on the first attempt: one captured attempt, settlement captured, allowance stays available (cumulative wallet)', async () => {
    const db = openTestDb()
    const now = 1_000_000
    const { settlementId, mandateId } = makeApprovedSettlement(db, { now, expiresAt: now + 3600 })
    const driver = makeScriptedDriver([captured('pay-happy')])

    const outcome = await runOnce({ ...baseRunnerDeps(db), driver, now: () => now }, settlementId)

    expect(outcome).toEqual(expect.objectContaining({ kind: 'captured', paymentId: 'pay-happy' }))

    const settlement = db
      .prepare('SELECT state FROM settlements WHERE id = ?')
      .get(settlementId) as {
      state: string
    }
    expect(settlement.state).toBe('captured')

    const attempts = db
      .prepare('SELECT state, provider_payment_id FROM settlement_attempts WHERE settlement_id = ?')
      .all(settlementId) as { state: string; provider_payment_id: string | null }[]
    expect(attempts).toHaveLength(1)
    expect(attempts[0]).toMatchObject({ state: 'captured', provider_payment_id: 'pay-happy' })

    // Cumulative wallet: a capture does NOT consume the allowance — the mandate
    // stays spendable until captured spend reaches the ceiling or it expires.
    const allowance = db
      .prepare('SELECT state FROM allowances WHERE mandate_id = ?')
      .get(mandateId) as {
      state: string
    }
    expect(allowance.state).toBe('available')

    const ledgerTypes = (
      db
        .prepare('SELECT event_type FROM ledger_events WHERE settlement_id = ? ORDER BY rowid')
        .all(settlementId) as { event_type: string }[]
    ).map((r) => r.event_type)
    expect(ledgerTypes).toContain('attempt_initiated')
    expect(ledgerTypes).toContain('payment_captured')
  })

  it('writes the attempt row and provider_order_id before the driver is ever called (write-ahead)', async () => {
    const db = openTestDb()
    const now = 1_000_000
    const { settlementId } = makeApprovedSettlement(db, { now, expiresAt: now + 3600 })

    let seenBeforeDriverCall: { attemptCount: number; orderIdMatches: boolean } | undefined
    const driver: SettleDriver = {
      async settleViaCheckout(args) {
        const count = db
          .prepare('SELECT COUNT(*) c FROM settlement_attempts WHERE settlement_id = ?')
          .get(settlementId) as { c: number }
        const row = db
          .prepare('SELECT provider_order_id FROM settlement_attempts WHERE settlement_id = ?')
          .get(settlementId) as { provider_order_id: string | null }
        seenBeforeDriverCall = {
          attemptCount: count.c,
          orderIdMatches: row.provider_order_id === args.orderId,
        }
        return captured()
      },
    }

    await runOnce({ ...baseRunnerDeps(db), driver, now: () => now }, settlementId)

    expect(seenBeforeDriverCall).toEqual({ attemptCount: 1, orderIdMatches: true })
  })
})

describe('runOnce — retry', () => {
  it('retries after a failed attempt: two attempt rows (failed, then captured), settlement captured', async () => {
    const db = openTestDb()
    const now = 1_000_000
    const { settlementId } = makeApprovedSettlement(db, { now, expiresAt: now + 3600 })
    const driver = makeScriptedDriver([failed(), captured()])

    const outcome = await runOnce({ ...baseRunnerDeps(db), driver, now: () => now }, settlementId)

    expect(outcome.kind).toBe('captured')
    const attempts = db
      .prepare('SELECT state FROM settlement_attempts WHERE settlement_id = ? ORDER BY rowid')
      .all(settlementId) as { state: string }[]
    expect(attempts.map((a) => a.state)).toEqual(['failed', 'captured'])
  })
})

describe('runOnce — all attempts fail, falls back to a payment link', () => {
  it('supersedes/terminates the driver attempts and issues a payment link, settlement stays settling', async () => {
    const db = openTestDb()
    const now = 1_000_000
    const { settlementId } = makeApprovedSettlement(db, { now, expiresAt: now + 3600 })
    const driver = makeScriptedDriver([failed(), failed(), failed()])
    const razorpay = makeFakeRazorpay()

    const outcome = await runOnce({ db, razorpay, driver, now: () => now }, settlementId)

    expect(outcome.kind).toBe('payment_link_issued')
    if (outcome.kind !== 'payment_link_issued') throw new Error('unreachable')
    expect(outcome.shortUrl).toMatch(/^https:\/\/rzp\.io\/l\//)

    const attempts = db
      .prepare(
        'SELECT method, state, provider_link_id FROM settlement_attempts WHERE settlement_id = ? ORDER BY rowid',
      )
      .all(settlementId) as { method: string; state: string; provider_link_id: string | null }[]
    expect(attempts).toHaveLength(4)
    for (const a of attempts.slice(0, 3)) {
      expect(a).toMatchObject({ method: 'checkout_driver', state: 'failed' })
    }
    expect(attempts[3]).toMatchObject({ method: 'payment_link' })
    expect(attempts[3]?.provider_link_id).toBeTruthy()

    const settlement = db
      .prepare('SELECT state FROM settlements WHERE id = ?')
      .get(settlementId) as {
      state: string
    }
    expect(settlement.state).toBe('settling')

    const ledgerTypes = (
      db
        .prepare('SELECT event_type FROM ledger_events WHERE settlement_id = ? ORDER BY rowid')
        .all(settlementId) as { event_type: string }[]
    ).map((r) => r.event_type)
    expect(ledgerTypes).toContain('payment_link_issued')
  })
})

describe('runOnce — TOCTOU re-verify', () => {
  it('CASes approved -> rejected when the mandate was revoked since approval; no attempt row, no order created', async () => {
    const db = openTestDb()
    const now = 1_000_000
    const { settlementId, mandateId } = makeApprovedSettlement(db, { now, expiresAt: now + 3600 })
    db.prepare('UPDATE mandates SET revoked_at = unixepoch() WHERE mandate_id = ?').run(mandateId)

    const razorpay = makeFakeRazorpay()
    const driver = makeScriptedDriver([captured()])
    const outcome = await runOnce({ db, razorpay, driver, now: () => now }, settlementId)

    expect(outcome).toEqual({ kind: 'rejected', reason: 'MANDATE_REVOKED' })
    const settlement = db
      .prepare('SELECT state, reject_reason FROM settlements WHERE id = ?')
      .get(settlementId) as { state: string; reject_reason: string | null }
    expect(settlement).toEqual({ state: 'rejected', reject_reason: 'MANDATE_REVOKED' })

    expect(driver.calls).toHaveLength(0)
    expect(razorpay.orders).toHaveLength(0)
    const attemptCount = db
      .prepare('SELECT COUNT(*) c FROM settlement_attempts WHERE settlement_id = ?')
      .get(settlementId) as { c: number }
    expect(attemptCount.c).toBe(0)
  })

  it('CASes approved -> rejected when the mandate expired since approval', async () => {
    const db = openTestDb()
    const now = 1_000_000
    const { settlementId } = makeApprovedSettlement(db, { now, expiresAt: now + 120 })

    const razorpay = makeFakeRazorpay()
    const driver = makeScriptedDriver([captured()])
    // 400s later: past expires_at (120s from now) plus the 60s clock-skew grace window.
    const outcome = await runOnce({ db, razorpay, driver, now: () => now + 400 }, settlementId)

    expect(outcome).toEqual({ kind: 'rejected', reason: 'MANDATE_EXPIRED' })
    expect(driver.calls).toHaveLength(0)
    expect(razorpay.orders).toHaveLength(0)
  })
})

describe('runOnce — double-capture guard', () => {
  it('never produces a second captured attempt: a repeat runOnce on an already-captured settlement is a no-op', async () => {
    const db = openTestDb()
    const now = 1_000_000
    const { settlementId } = makeApprovedSettlement(db, { now, expiresAt: now + 3600 })
    const deps = { ...baseRunnerDeps(db), driver: makeScriptedDriver([captured()]), now: () => now }

    const first = await runOnce(deps, settlementId)
    expect(first.kind).toBe('captured')

    const second = await runOnce(deps, settlementId)
    expect(second).toEqual({ kind: 'no_op' })

    const capturedCount = db
      .prepare(
        `SELECT COUNT(*) c FROM settlement_attempts WHERE settlement_id = ? AND state = 'captured'`,
      )
      .get(settlementId) as { c: number }
    expect(capturedCount.c).toBe(1)

    // The DB invariant the executor's single-flight design + reverify guard are
    // relying on to never be exercised in practice — proven directly here.
    expectSqliteConstraintViolation(() =>
      db
        .prepare(
          `INSERT INTO settlement_attempts (id, settlement_id, method, state, receipt) VALUES (?, ?, 'checkout_driver', 'captured', ?)`,
        )
        .run('forced-dup-capture', settlementId, 'forced-dup-receipt'),
    )
  })
})

describe('handleProviderCapture — compensator', () => {
  function makeTerminalSettlementWithLateAttempt(db: ReturnType<typeof openTestDb>) {
    const settlementId = insertSettlement(db, { state: 'created' })
    transitionSettlement(db, settlementId, 'created', 'verifying')
    transitionSettlement(db, settlementId, 'verifying', 'verified')
    transitionSettlement(db, settlementId, 'verified', 'approved')
    transitionSettlement(db, settlementId, 'approved', 'settling')
    db.prepare(
      `INSERT INTO settlement_attempts (id, settlement_id, method, state, receipt, provider_order_id)
       VALUES ('attempt-late', ?, 'checkout_driver', 'failed', 'r-late', 'order-late')`,
    ).run(settlementId)
    transitionSettlement(db, settlementId, 'settling', 'failed')
    return settlementId
  }

  it('refunds and ledgers anomaly_refund_issued when a capture lands for an already-terminal settlement', async () => {
    const db = openTestDb()
    const settlementId = makeTerminalSettlementWithLateAttempt(db)

    let refundCalls = 0
    const razorpay = makeFakeRazorpay({
      async refundPayment(input) {
        refundCalls += 1
        return { id: 'rfnd-1', payment_id: input.paymentId, status: 'processed', amount: 0 }
      },
    })

    await handleProviderCapture({ db, razorpay }, { orderId: 'order-late', paymentId: 'pay-late' })

    expect(refundCalls).toBe(1)
    const row = db
      .prepare(
        `SELECT payload FROM ledger_events WHERE event_type = 'anomaly_refund_issued' AND settlement_id = ?`,
      )
      .get(settlementId) as { payload: string } | undefined
    expect(row).toBeDefined()
    expect(JSON.parse(row?.payload ?? '{}')).toMatchObject({
      payment_id: 'pay-late',
      refund_id: 'rfnd-1',
    })
  })

  it('does not throw and ledgers reconciliation_flagged when the refund API errors', async () => {
    const db = openTestDb()
    const settlementId = makeTerminalSettlementWithLateAttempt(db)

    const razorpay = makeFakeRazorpay({
      async refundPayment() {
        throw new Error('razorpay refund endpoint down')
      },
    })

    await expect(
      handleProviderCapture({ db, razorpay }, { orderId: 'order-late', paymentId: 'pay-late' }),
    ).resolves.toBeUndefined()

    const row = db
      .prepare(
        `SELECT payload FROM ledger_events WHERE event_type = 'reconciliation_flagged' AND settlement_id = ?`,
      )
      .get(settlementId) as { payload: string } | undefined
    expect(row).toBeDefined()
    expect(JSON.parse(row?.payload ?? '{}')).toMatchObject({ reason: 'refund_api_error' })
  })

  it('is idempotent: a normal capture for the live/expected attempt is not an anomaly', async () => {
    const db = openTestDb()
    const now = 1_000_000
    const { settlementId } = makeApprovedSettlement(db, { now, expiresAt: now + 3600 })
    const driver = makeScriptedDriver([captured('pay-normal')])
    await runOnce({ ...baseRunnerDeps(db), driver, now: () => now }, settlementId)

    const attempt = db
      .prepare(`SELECT provider_order_id FROM settlement_attempts WHERE settlement_id = ?`)
      .get(settlementId) as { provider_order_id: string }

    let refundCalls = 0
    const razorpay = makeFakeRazorpay({
      async refundPayment(input) {
        refundCalls += 1
        return { id: 'rfnd-2', payment_id: input.paymentId, status: 'processed', amount: 0 }
      },
    })

    await handleProviderCapture(
      { db, razorpay },
      { orderId: attempt.provider_order_id, paymentId: 'pay-normal' },
    )

    expect(refundCalls).toBe(0)
  })
})

describe('createExecutor — concurrency and idempotent kicks', () => {
  it('a second execute() for a settlement already in flight is a no-op: exactly one attempt row', async () => {
    const db = openTestDb()
    const now = 1_000_000
    const { settlementId } = makeApprovedSettlement(db, { now, expiresAt: now + 3600 })
    const driver = makeScriptedDriver([captured()])
    const executor = createExecutor({
      db,
      env: TEST_ENV,
      driver,
      now: () => now,
      razorpay: makeFakeRazorpay(),
    })

    executor.execute(settlementId)
    executor.execute(settlementId) // synchronous no-op: the first kick already claimed this id
    await executor.waitForIdle()

    expect(driver.calls).toHaveLength(1)
    const attemptCount = db
      .prepare('SELECT COUNT(*) c FROM settlement_attempts WHERE settlement_id = ?')
      .get(settlementId) as { c: number }
    expect(attemptCount.c).toBe(1)
  })

  it('execute() on a non-approved settlement is a no-op', async () => {
    const db = openTestDb()
    const settlementId = insertSettlement(db, { state: 'created' })
    const driver = makeScriptedDriver([captured()])
    const executor = createExecutor({ db, env: TEST_ENV, driver, razorpay: makeFakeRazorpay() })

    executor.execute(settlementId)
    await executor.waitForIdle()

    expect(driver.calls).toHaveLength(0)
    const settlement = db
      .prepare('SELECT state FROM settlements WHERE id = ?')
      .get(settlementId) as {
      state: string
    }
    expect(settlement.state).toBe('created')
  })
})
