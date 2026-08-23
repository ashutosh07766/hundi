import { describe, expect, it } from 'vitest'
import type { RazorpayPayment } from '../razorpay-client.js'
import { applyCapture, reconcileByAttempt, reconcileByOrder } from '../reconcile.js'
import { transitionSettlement } from '../state-machine.js'
import { makeApprovedSettlement, makeFakeRazorpay } from './executor-helpers.js'
import { driveSettlementToFailed, insertAttempt, insertSettlement, openTestDb } from './helpers.js'

/** Drives a fresh approved settlement into `settling` with one live checkout_driver
 * attempt carrying `providerOrderId` — the shape reconcile expects to find when the
 * sweep polls a stale attempt. */
function makeSettlingAttempt(db: ReturnType<typeof openTestDb>, providerOrderId: string) {
  const now = 1_000_000
  const { settlementId, mandateId } = makeApprovedSettlement(db, { now, expiresAt: now + 3600 })
  transitionSettlement(db, settlementId, 'approved', 'settling')
  const attemptId = insertAttempt(db, {
    settlement_id: settlementId,
    method: 'checkout_driver',
    state: 'initiated',
    provider_order_id: providerOrderId,
  })
  return { settlementId, mandateId, attemptId }
}

function paymentsOf(status: string, id = 'pay-1'): RazorpayPayment[] {
  return [{ id, order_id: 'order-x', status, amount: 1000 }]
}

describe('applyCapture', () => {
  it('drives a live attempt to captured: settlement captured, allowance stays available, ledger payment_captured', () => {
    const db = openTestDb()
    const { settlementId, mandateId, attemptId } = makeSettlingAttempt(db, 'order-direct')

    const ok = applyCapture(
      db,
      {
        attemptId,
        attemptState: 'initiated',
        settlementId,
        mandateId,
        providerOrderId: 'order-direct',
      },
      'pay-direct',
    )

    expect(ok).toBe(true)
    const settlement = db
      .prepare('SELECT state FROM settlements WHERE id = ?')
      .get(settlementId) as {
      state: string
    }
    expect(settlement.state).toBe('captured')
    // Cumulative wallet: capture leaves the allowance available — the mandate is
    // reusable up to its ceiling, not single-use.
    const allowance = db
      .prepare('SELECT state FROM allowances WHERE mandate_id = ?')
      .get(mandateId) as {
      state: string
    }
    expect(allowance.state).toBe('available')
    const ledgerTypes = (
      db
        .prepare('SELECT event_type FROM ledger_events WHERE settlement_id = ? ORDER BY seq')
        .all(settlementId) as { event_type: string }[]
    ).map((r) => r.event_type)
    expect(ledgerTypes).toContain('payment_captured')
  })

  it('returns false without throwing when the attempt already moved (stale CAS)', () => {
    const db = openTestDb()
    const { settlementId, mandateId, attemptId } = makeSettlingAttempt(db, 'order-race')
    // Simulate a concurrent writer already having captured this attempt.
    applyCapture(
      db,
      {
        attemptId,
        attemptState: 'initiated',
        settlementId,
        mandateId,
        providerOrderId: 'order-race',
      },
      'pay-race',
    )

    const second = applyCapture(
      db,
      {
        attemptId,
        attemptState: 'initiated',
        settlementId,
        mandateId,
        providerOrderId: 'order-race',
      },
      'pay-race-2',
    )
    expect(second).toBe(false)
  })
})

describe('reconcileByOrder — normal capture path', () => {
  it('applies the truth when Razorpay reports captured and our attempt is still live', async () => {
    const db = openTestDb()
    const { settlementId, attemptId } = makeSettlingAttempt(db, 'order-cap')
    const razorpay = makeFakeRazorpay({
      async fetchOrderPayments() {
        return paymentsOf('captured', 'pay-cap')
      },
    })

    const outcome = await reconcileByOrder({ db, razorpay }, 'order-cap')

    expect(outcome).toEqual({ kind: 'captured', attemptId, paymentId: 'pay-cap' })
    const attempt = db
      .prepare('SELECT state FROM settlement_attempts WHERE id = ?')
      .get(attemptId) as {
      state: string
    }
    expect(attempt.state).toBe('captured')
    const settlement = db
      .prepare('SELECT state FROM settlements WHERE id = ?')
      .get(settlementId) as {
      state: string
    }
    expect(settlement.state).toBe('captured')
  })

  it('fails the attempt when Razorpay reports failed', async () => {
    const db = openTestDb()
    const { attemptId } = makeSettlingAttempt(db, 'order-fail')
    const razorpay = makeFakeRazorpay({
      async fetchOrderPayments() {
        return paymentsOf('failed', 'pay-fail')
      },
    })

    const outcome = await reconcileByOrder({ db, razorpay }, 'order-fail')

    expect(outcome).toEqual({ kind: 'failed', attemptId })
    const attempt = db
      .prepare('SELECT state FROM settlement_attempts WHERE id = ?')
      .get(attemptId) as {
      state: string
    }
    expect(attempt.state).toBe('failed')
  })

  it('is a no-op when no terminal payment exists yet', async () => {
    const db = openTestDb()
    makeSettlingAttempt(db, 'order-pending')
    const razorpay = makeFakeRazorpay({
      async fetchOrderPayments() {
        return paymentsOf('created', 'pay-pending')
      },
    })

    const outcome = await reconcileByOrder({ db, razorpay }, 'order-pending')
    expect(outcome).toEqual({ kind: 'no_op' })
  })

  it('returns not_found for an order id with no matching attempt', async () => {
    const db = openTestDb()
    const razorpay = makeFakeRazorpay()
    const outcome = await reconcileByOrder({ db, razorpay }, 'order-unknown')
    expect(outcome).toEqual({ kind: 'not_found' })
  })

  it('flags reconciliation and no-ops when fetchOrderPayments itself errors', async () => {
    const db = openTestDb()
    const { settlementId } = makeSettlingAttempt(db, 'order-err')
    const razorpay = makeFakeRazorpay({
      async fetchOrderPayments() {
        throw new Error('razorpay is down')
      },
    })

    const outcome = await reconcileByOrder({ db, razorpay }, 'order-err')
    expect(outcome).toEqual({ kind: 'no_op' })
    const row = db
      .prepare(
        `SELECT payload FROM ledger_events WHERE event_type = 'reconciliation_flagged' AND settlement_id = ?`,
      )
      .get(settlementId) as { payload: string } | undefined
    expect(row).toBeDefined()
    expect(JSON.parse(row?.payload ?? '{}')).toMatchObject({
      reason: 'fetch_order_payments_failed',
    })
  })
})

describe('reconcileByOrder — compensator (money-race close)', () => {
  it('refunds when the capture is authoritative for an attempt whose settlement already went terminal', async () => {
    const db = openTestDb()
    const settlementId = insertSettlement(db, { state: 'created' })
    driveSettlementToFailed(db, settlementId)
    const attemptId = insertAttempt(db, {
      settlement_id: settlementId,
      method: 'checkout_driver',
      state: 'failed',
      provider_order_id: 'order-late',
    })

    let refundCalls = 0
    const razorpay = makeFakeRazorpay({
      async fetchOrderPayments() {
        return paymentsOf('captured', 'pay-late')
      },
      async refundPayment(input) {
        refundCalls += 1
        return { id: 'rfnd-recon-1', payment_id: input.paymentId, status: 'processed', amount: 0 }
      },
    })

    const outcome = await reconcileByOrder({ db, razorpay }, 'order-late')

    expect(outcome).toEqual({ kind: 'anomaly_refunded' })
    expect(refundCalls).toBe(1)
    const row = db
      .prepare(
        `SELECT payload FROM ledger_events WHERE event_type = 'anomaly_refund_issued' AND settlement_id = ?`,
      )
      .get(settlementId) as { payload: string } | undefined
    expect(JSON.parse(row?.payload ?? '{}')).toMatchObject({
      payment_id: 'pay-late',
      attempt_id: attemptId,
    })
  })

  it('cross-settlement variant: an abandoned settlement whose payment-link attempt captures late is refunded', async () => {
    const db = openTestDb()
    const settlementId = insertSettlement(db, { state: 'created' })
    transitionSettlement(db, settlementId, 'created', 'verifying')
    transitionSettlement(db, settlementId, 'verifying', 'verified')
    transitionSettlement(db, settlementId, 'verified', 'approved')
    transitionSettlement(db, settlementId, 'approved', 'settling')
    transitionSettlement(db, settlementId, 'settling', 'abandoned')
    insertAttempt(db, {
      settlement_id: settlementId,
      method: 'payment_link',
      state: 'awaiting_confirmation',
      provider_order_id: 'order-link-late',
    })

    let refundCalls = 0
    const razorpay = makeFakeRazorpay({
      async fetchOrderPayments() {
        return paymentsOf('captured', 'pay-link-late')
      },
      async refundPayment(input) {
        refundCalls += 1
        return { id: 'rfnd-recon-2', payment_id: input.paymentId, status: 'processed', amount: 0 }
      },
    })

    const outcome = await reconcileByOrder({ db, razorpay }, 'order-link-late')

    expect(outcome).toEqual({ kind: 'anomaly_refunded' })
    expect(refundCalls).toBe(1)
  })
})

describe('reconcileByAttempt', () => {
  it('delegates to reconcileByOrder when the attempt has a provider order id', async () => {
    const db = openTestDb()
    const { attemptId } = makeSettlingAttempt(db, 'order-via-attempt')
    const razorpay = makeFakeRazorpay({
      async fetchOrderPayments() {
        return paymentsOf('captured', 'pay-via-attempt')
      },
    })

    const outcome = await reconcileByAttempt({ db, razorpay }, attemptId)
    expect(outcome).toEqual({ kind: 'captured', attemptId, paymentId: 'pay-via-attempt' })
  })

  it('no-ops when the attempt has no provider order id yet', async () => {
    const db = openTestDb()
    const attemptId = insertAttempt(db, { method: 'checkout_driver', state: 'initiated' })
    const razorpay = makeFakeRazorpay()

    const outcome = await reconcileByAttempt({ db, razorpay }, attemptId)
    expect(outcome).toEqual({ kind: 'no_op' })
  })

  it('returns not_found for an unknown attempt id', async () => {
    const db = openTestDb()
    const razorpay = makeFakeRazorpay()
    const outcome = await reconcileByAttempt({ db, razorpay }, 'nope')
    expect(outcome).toEqual({ kind: 'not_found' })
  })
})
