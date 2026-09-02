import { describe, expect, it } from 'vitest'
import { RazorpayApiError } from '../razorpay-client.js'
import { makeFakeRazorpay } from './executor-helpers.js'
import { insertAttempt, insertSettlement } from './helpers.js'
import { makeTestApp, postJson, TEST_ENV } from './http-helpers.js'

const DASHBOARD_HEADERS = { 'x-hundi-dashboard-token': TEST_ENV.DASHBOARD_TOKEN }

describe('POST /settlements/:id/refund', () => {
  it('refunds a captured settlement and records a refund_issued ledger event', async () => {
    let refundCalls = 0
    const razorpay = makeFakeRazorpay({
      async refundPayment({ paymentId }) {
        refundCalls += 1
        return { id: 'rfnd-fixed-1', payment_id: paymentId, status: 'processed', amount: 50_000 }
      },
    })
    const { app, db } = makeTestApp({ razorpay })
    const settlementId = insertSettlement(db, { state: 'captured', amount_paise: 50_000 })
    insertAttempt(db, {
      settlement_id: settlementId,
      state: 'captured',
      provider_payment_id: 'pay_test_1',
    })

    const res = await postJson(app, `/settlements/${settlementId}/refund`, {}, DASHBOARD_HEADERS)
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json).toMatchObject({
      ok: true,
      settlement_id: settlementId,
      refund_id: 'rfnd-fixed-1',
      amount_paise: 50_000,
    })
    expect(refundCalls).toBe(1)

    const ledgerRow = db
      .prepare(
        `SELECT payload FROM ledger_events WHERE event_type = 'refund_issued' AND settlement_id = ?`,
      )
      .get(settlementId) as { payload: string } | undefined
    expect(ledgerRow).toBeDefined()
    const payload = JSON.parse((ledgerRow as { payload: string }).payload)
    expect(payload).toMatchObject({
      payment_id: 'pay_test_1',
      refund_id: 'rfnd-fixed-1',
      amount_paise: 50_000,
    })
  })

  it('rejects a refund of a non-captured settlement with 409 SETTLEMENT_NOT_CAPTURED', async () => {
    const { app, db } = makeTestApp()
    const settlementId = insertSettlement(db, { state: 'created' })

    const res = await postJson(app, `/settlements/${settlementId}/refund`, {}, DASHBOARD_HEADERS)
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ ok: false, error: 'SETTLEMENT_NOT_CAPTURED' })
  })

  it('rejects a captured settlement with no captured attempt/payment id with 409 NO_CAPTURED_PAYMENT', async () => {
    const { app, db } = makeTestApp()
    // A captured settlement whose only attempt row never got a provider_payment_id
    // recorded — the kind of stranded state a crash between capture and the
    // provider_payment_id write could leave behind.
    const settlementId = insertSettlement(db, { state: 'captured', amount_paise: 10_000 })
    insertAttempt(db, { settlement_id: settlementId, state: 'failed' })

    const res = await postJson(app, `/settlements/${settlementId}/refund`, {}, DASHBOARD_HEADERS)
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ ok: false, error: 'NO_CAPTURED_PAYMENT' })
  })

  it('is idempotent: a second refund of an already-refunded settlement replays the same result without a second provider call', async () => {
    let refundCalls = 0
    const razorpay = makeFakeRazorpay({
      async refundPayment({ paymentId }) {
        refundCalls += 1
        return {
          id: `rfnd-${refundCalls}`,
          payment_id: paymentId,
          status: 'processed',
          amount: 25_000,
        }
      },
    })
    const { app, db } = makeTestApp({ razorpay })
    const settlementId = insertSettlement(db, { state: 'captured', amount_paise: 25_000 })
    insertAttempt(db, {
      settlement_id: settlementId,
      state: 'captured',
      provider_payment_id: 'pay_test_2',
    })

    const first = await postJson(app, `/settlements/${settlementId}/refund`, {}, DASHBOARD_HEADERS)
    const firstJson = await first.json()

    const second = await postJson(app, `/settlements/${settlementId}/refund`, {}, DASHBOARD_HEADERS)
    const secondJson = await second.json()

    expect(second.status).toBe(200)
    expect(secondJson).toEqual(firstJson)
    // Exactly one real provider call, no double refund.
    expect(refundCalls).toBe(1)

    const count = db
      .prepare(
        `SELECT COUNT(*) AS c FROM ledger_events WHERE event_type = 'refund_issued' AND settlement_id = ?`,
      )
      .get(settlementId) as { c: number }
    expect(count.c).toBe(1)
  })

  it('maps a Razorpay failure to 502 REFUND_PROVIDER_ERROR (with the provider reason) and writes no ledger event', async () => {
    const razorpay = makeFakeRazorpay({
      async refundPayment() {
        throw new RazorpayApiError(400, {
          error: {
            code: 'BAD_REQUEST_ERROR',
            description: 'The payment has been fully refunded already',
          },
        })
      },
    })
    const { app, db } = makeTestApp({ razorpay })
    const settlementId = insertSettlement(db, { state: 'captured', amount_paise: 10_000 })
    insertAttempt(db, {
      settlement_id: settlementId,
      state: 'captured',
      provider_payment_id: 'pay_test_poison',
    })

    const res = await postJson(app, `/settlements/${settlementId}/refund`, {}, DASHBOARD_HEADERS)
    expect(res.status).toBe(502)
    expect(await res.json()).toMatchObject({
      ok: false,
      error: 'REFUND_PROVIDER_ERROR',
      reason: 'The payment has been fully refunded already',
    })
    // A provider failure must not leave a phantom refund_issued behind.
    const count = db
      .prepare(
        `SELECT COUNT(*) AS c FROM ledger_events WHERE event_type = 'refund_issued' AND settlement_id = ?`,
      )
      .get(settlementId) as { c: number }
    expect(count.c).toBe(0)
  })

  it('rejects without the dashboard token', async () => {
    const { app, db } = makeTestApp()
    const settlementId = insertSettlement(db, { state: 'captured', amount_paise: 10_000 })
    insertAttempt(db, {
      settlement_id: settlementId,
      state: 'captured',
      provider_payment_id: 'pay_test_3',
    })

    const res = await postJson(app, `/settlements/${settlementId}/refund`, {})
    expect(res.status).toBe(401)
  })

  it('returns 404 for an unknown settlement id', async () => {
    const { app } = makeTestApp()
    const res = await postJson(app, '/settlements/no-such-settlement/refund', {}, DASHBOARD_HEADERS)
    expect(res.status).toBe(404)
    expect(await res.json()).toMatchObject({ ok: false, error: 'SETTLEMENT_NOT_FOUND' })
  })
})
