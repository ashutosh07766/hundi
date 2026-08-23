import { createHmac } from 'node:crypto'
import type { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import type { RazorpayPayment } from '../razorpay-client.js'
import { transitionSettlement } from '../state-machine.js'
import { makeApprovedSettlement, makeFakeRazorpay } from './executor-helpers.js'
import { insertAttempt, openTestDb } from './helpers.js'
import { makeTestApp, TEST_ENV } from './http-helpers.js'

function sign(rawBody: string): string {
  return createHmac('sha256', TEST_ENV.RAZORPAY_WEBHOOK_SECRET).update(rawBody).digest('hex')
}

async function postWebhook(
  app: Hono,
  rawBody: string,
  headers: Record<string, string> = {},
): Promise<Response> {
  return app.request('/webhook', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: rawBody,
  })
}

function capturedEventBody(orderId: string, paymentId: string, event = 'payment.captured') {
  return JSON.stringify({
    entity: 'event',
    event,
    payload: { payment: { entity: { id: paymentId, order_id: orderId, status: 'captured' } } },
  })
}

/** Settlement in `settling` with one live checkout_driver attempt pinned to `orderId` —
 * the shape a payment.captured webhook needs to find and converge. */
function makeSettlingAttempt(db: ReturnType<typeof openTestDb>, orderId: string) {
  const now = 1_000_000
  const { settlementId } = makeApprovedSettlement(db, { now, expiresAt: now + 3600 })
  transitionSettlement(db, settlementId, 'approved', 'settling')
  const attemptId = insertAttempt(db, {
    settlement_id: settlementId,
    method: 'checkout_driver',
    state: 'initiated',
    provider_order_id: orderId,
  })
  return { settlementId, attemptId }
}

describe('POST /webhook — signature verification', () => {
  it('rejects an invalid signature with 400 and ledgers webhook_rejected, no state change', async () => {
    const { app, db } = makeTestApp()
    const rawBody = capturedEventBody('order-x', 'pay-x')

    const res = await postWebhook(app, rawBody, {
      'x-razorpay-signature': 'not-the-real-signature',
      'x-razorpay-event-id': 'evt-bad-sig',
    })

    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json).toMatchObject({ ok: false, error: 'WEBHOOK_SIGNATURE_INVALID' })

    const row = db
      .prepare(`SELECT payload FROM ledger_events WHERE event_type = 'webhook_rejected'`)
      .get() as { payload: string } | undefined
    expect(row).toBeDefined()
    expect(JSON.parse(row?.payload ?? '{}')).toMatchObject({
      event_id: 'evt-bad-sig',
      reason: 'signature_invalid',
    })
    const stored = db.prepare('SELECT 1 FROM webhook_events WHERE event_id = ?').get('evt-bad-sig')
    expect(stored).toBeUndefined()
  })

  it('rejects a garbage (non-JSON) body with no valid signature as 400 before ever parsing it', async () => {
    const { app } = makeTestApp()
    const rawBody = '{not json at all'

    const res = await postWebhook(app, rawBody, {
      'x-razorpay-signature': 'garbage-signature',
      'x-razorpay-event-id': 'evt-garbage',
    })

    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json).toMatchObject({ ok: false, error: 'WEBHOOK_SIGNATURE_INVALID' })
  })

  it('rejects a validly-signed but non-JSON body as 400 WEBHOOK_BODY_INVALID', async () => {
    const { app } = makeTestApp()
    const rawBody = '{not json at all'

    const res = await postWebhook(app, rawBody, {
      'x-razorpay-signature': sign(rawBody),
      'x-razorpay-event-id': 'evt-nonjson',
    })

    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json).toMatchObject({ ok: false, error: 'WEBHOOK_BODY_INVALID' })
  })
})

describe('POST /webhook — dedup', () => {
  it('processes a known event once: first delivery reconciles, replayed event_id is a 200 no-op', async () => {
    const db = openTestDb()
    const { settlementId, attemptId } = makeSettlingAttempt(db, 'order-dedup')

    let fetchCalls = 0
    const razorpay = makeFakeRazorpay({
      async fetchOrderPayments(): Promise<RazorpayPayment[]> {
        fetchCalls += 1
        return [{ id: 'pay-dedup', order_id: 'order-dedup', status: 'captured', amount: 1000 }]
      },
    })
    const { createApp } = await import('../app.js')
    const app = createApp({
      db,
      executor: { execute() {}, resumeSettling() {} },
      env: TEST_ENV,
      razorpay,
    })

    const rawBody = capturedEventBody('order-dedup', 'pay-dedup')
    const headers = { 'x-razorpay-signature': sign(rawBody), 'x-razorpay-event-id': 'evt-dedup-1' }

    const first = await postWebhook(app, rawBody, headers)
    expect(first.status).toBe(200)
    expect(fetchCalls).toBe(1)

    const second = await postWebhook(app, rawBody, headers)
    expect(second.status).toBe(200)
    const secondJson = await second.json()
    expect(secondJson).toMatchObject({ ok: true, duplicate: true })
    expect(fetchCalls).toBe(1) // not re-invoked on replay

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

    const receivedCount = (
      db
        .prepare(`SELECT COUNT(*) c FROM ledger_events WHERE event_type = 'webhook_received'`)
        .get() as {
        c: number
      }
    ).c
    expect(receivedCount).toBe(1)
  })
})

describe('POST /webhook — event handling', () => {
  it('stores and 200s an unknown event type without touching reconcile', async () => {
    const db = openTestDb()
    const razorpay = makeFakeRazorpay({
      async fetchOrderPayments(): Promise<RazorpayPayment[]> {
        throw new Error('should not be called for an unknown event type')
      },
    })
    const { createApp } = await import('../app.js')
    const app = createApp({
      db,
      executor: { execute() {}, resumeSettling() {} },
      env: TEST_ENV,
      razorpay,
    })

    const rawBody = JSON.stringify({ event: 'order.paid', payload: {} })
    const res = await postWebhook(app, rawBody, {
      'x-razorpay-signature': sign(rawBody),
      'x-razorpay-event-id': 'evt-unknown',
    })

    expect(res.status).toBe(200)
    const stored = db
      .prepare('SELECT event_type FROM webhook_events WHERE event_id = ?')
      .get('evt-unknown') as { event_type: string } | undefined
    expect(stored).toEqual({ event_type: 'order.paid' })
    const receivedRow = db
      .prepare(`SELECT payload FROM ledger_events WHERE event_type = 'webhook_received'`)
      .get() as { payload: string } | undefined
    expect(receivedRow).toBeDefined()
  })

  it('always 200s a validly-signed event even when it cannot be matched to a settlement', async () => {
    const db = openTestDb()
    const razorpay = makeFakeRazorpay()
    const { createApp } = await import('../app.js')
    const app = createApp({
      db,
      executor: { execute() {}, resumeSettling() {} },
      env: TEST_ENV,
      razorpay,
    })

    const rawBody = capturedEventBody('order-unmatched', 'pay-unmatched')
    const res = await postWebhook(app, rawBody, {
      'x-razorpay-signature': sign(rawBody),
      'x-razorpay-event-id': 'evt-unmatched',
    })

    expect(res.status).toBe(200)
    // Stored for the sweep to reprocess (reconcileByOrder itself finds no matching
    // attempt and no-ops — see reconcile.test.ts's `not_found` case) — the webhook
    // handler's job here is only to ack + persist, not to flag an error.
    const stored = db
      .prepare('SELECT event_type FROM webhook_events WHERE event_id = ?')
      .get('evt-unmatched') as { event_type: string } | undefined
    expect(stored).toEqual({ event_type: 'payment.captured' })
  })

  it('fails an attempt when the webhook-triggered reconcile finds payment.failed', async () => {
    const db = openTestDb()
    const { attemptId } = makeSettlingAttempt(db, 'order-failed-wh')
    const razorpay = makeFakeRazorpay({
      async fetchOrderPayments(): Promise<RazorpayPayment[]> {
        return [
          { id: 'pay-failed-wh', order_id: 'order-failed-wh', status: 'failed', amount: 1000 },
        ]
      },
    })
    const { createApp } = await import('../app.js')
    const app = createApp({
      db,
      executor: { execute() {}, resumeSettling() {} },
      env: TEST_ENV,
      razorpay,
    })

    const rawBody = JSON.stringify({
      event: 'payment.failed',
      payload: {
        payment: { entity: { id: 'pay-failed-wh', order_id: 'order-failed-wh', status: 'failed' } },
      },
    })
    const res = await postWebhook(app, rawBody, {
      'x-razorpay-signature': sign(rawBody),
      'x-razorpay-event-id': 'evt-failed-wh',
    })

    expect(res.status).toBe(200)
    const attempt = db
      .prepare('SELECT state FROM settlement_attempts WHERE id = ?')
      .get(attemptId) as {
      state: string
    }
    expect(attempt.state).toBe('failed')
  })
})
