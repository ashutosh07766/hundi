// Rail (a) decision-critical probe: server-to-server UPI collect against
// Razorpay TEST mode, with no checkout page in the loop.
//
// Flow: create an order -> POST /payments/create/json with a UPI collect
// intent -> poll /orders/:id/payments until the payment lands on a terminal
// status. This endpoint is not in Razorpay's public REST reference (it's the
// path their own test-mode tooling uses for headless UPI simulation) — if it
// 404s or comes back as an enablement error, that IS the answer for rail (a):
// this account/mode combination can't do pure S2S UPI collect, and the spike
// escalates to a checkout-driver probe instead of retrying.
//
// Exported so `repeat-probe.ts` can run the same flow N times without
// re-implementing the order/payment/poll sequence.

import { freshReceipt, loadEnv, logStep, requireEnv, rzpFetch, sleep } from './lib.ts'

loadEnv()

const POLL_INTERVAL_MS = 3_000
const POLL_TIMEOUT_MS = 90_000
const TERMINAL_STATUSES = new Set(['captured', 'authorized', 'failed'])

interface OrderResponse {
  id: string
  amount: number
  currency: string
  receipt: string
  status: string
}

interface PaymentCreateResponse {
  razorpay_payment_id?: string
  razorpay_order_id?: string
  next?: unknown[]
  error?: { code?: string; description?: string; reason?: string; [key: string]: unknown }
}

interface PaymentsListItem {
  id: string
  status: string
  [key: string]: unknown
}

interface PaymentsListResponse {
  entity: string
  count: number
  items: PaymentsListItem[]
}

export type S2sOutcome = 'captured' | 'authorized' | 'failed' | 'timeout' | 'creation_error'

export interface S2sFlowResult {
  outcome: S2sOutcome
  orderId?: string
  paymentId?: string
  latencyMs: number
}

/**
 * Runs one order -> S2S-UPI-create -> poll cycle. `vpa` selects Razorpay's
 * test-mode simulated outcome (`success@razorpay` / `failure@razorpay`).
 * Never throws on a Razorpay-side error — those are logged and folded into
 * the returned outcome so callers (including repeat-probe) can keep going.
 */
export async function runS2sFlow(vpa: string): Promise<S2sFlowResult> {
  const start = Date.now()
  requireEnv('RAZORPAY_KEY_ID')
  requireEnv('RAZORPAY_KEY_SECRET')

  const receipt = freshReceipt('spike-s2s')
  const orderRes = await rzpFetch<OrderResponse>('/orders', {
    method: 'POST',
    body: JSON.stringify({ amount: 100, currency: 'INR', receipt, payment_capture: 1 }),
  })
  logStep('create_order', orderRes.ok, orderRes.body)

  if (!orderRes.ok || !('id' in orderRes.body)) {
    return { outcome: 'creation_error', latencyMs: Date.now() - start }
  }
  const order = orderRes.body as OrderResponse

  const paymentBody = {
    amount: order.amount,
    currency: order.currency,
    order_id: order.id,
    email: 'spike@example.com',
    contact: '9999999999',
    method: 'upi',
    upi: { flow: 'collect', vpa },
  }

  let paymentRes = await rzpFetch<PaymentCreateResponse>('/payments/create/json', {
    method: 'POST',
    body: JSON.stringify(paymentBody),
  })

  // /payments/create/json is undocumented in Razorpay's public API
  // reference. If v1 404s outright (vs. a 4xx business error), try an
  // unversioned v2 host on the same path before giving up — the shape of
  // "v2" for this endpoint isn't documented anywhere, so this is a probe,
  // not a known-good fallback.
  if (paymentRes.status === 404) {
    logStep('create_payment_v1_404_trying_v2', true, { status: paymentRes.status })
    paymentRes = await rzpFetch<PaymentCreateResponse>(
      '/payments/create/json',
      { method: 'POST', body: JSON.stringify(paymentBody) },
      'https://api.razorpay.com/v2',
    )
  }

  logStep('create_payment', paymentRes.ok, paymentRes.body)
  if (!paymentRes.ok) {
    // Decision-critical: an enablement/feature-gate error here (e.g. "not
    // enabled for this merchant") means rail (a) is blocked at the account
    // level, not a transient failure. Print the full body — no summarizing.
    logStep('create_payment_error_full_body', false, paymentRes.body)
  }

  // Poll regardless of the create-payment result: Razorpay can attach a
  // payment to the order asynchronously even when the synchronous create
  // call errored or returned a pending next-action.
  const deadline = Date.now() + POLL_TIMEOUT_MS
  let lastStatus: string | undefined
  let paymentId: string | undefined

  while (Date.now() < deadline) {
    const listRes = await rzpFetch<PaymentsListResponse>(`/orders/${order.id}/payments`)
    if (listRes.ok && 'items' in listRes.body) {
      const items = (listRes.body as PaymentsListResponse).items
      const latest = items.at(-1)
      if (latest) {
        lastStatus = latest.status
        paymentId = latest.id
        logStep('poll_orders_payments', true, { status: lastStatus, paymentId })
        if (TERMINAL_STATUSES.has(lastStatus)) break
      } else {
        logStep('poll_orders_payments', true, { items: 0 })
      }
    } else {
      logStep('poll_orders_payments', false, listRes.body)
    }
    await sleep(POLL_INTERVAL_MS)
  }

  const latencyMs = Date.now() - start
  if (lastStatus === 'captured' || lastStatus === 'authorized' || lastStatus === 'failed') {
    return { outcome: lastStatus, orderId: order.id, paymentId, latencyMs }
  }
  return { outcome: 'timeout', orderId: order.id, paymentId, latencyMs }
}

async function main() {
  const result = await runS2sFlow('success@razorpay')
  const success = result.outcome === 'captured'
  logStep('final', success, result)
  process.exit(success ? 0 : 1)
}

const isDirectRun = import.meta.url === `file://${process.argv[1]}`
if (isDirectRun) {
  main().catch((err) => {
    logStep('fatal', false, { message: err instanceof Error ? err.message : String(err) })
    process.exit(1)
  })
}
