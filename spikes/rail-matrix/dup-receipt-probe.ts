// Idempotency probe: create two orders with the identical `receipt` string
// and see whether Razorpay enforces receipt uniqueness. Razorpay's docs are
// ambiguous about this in test mode, so this probe treats "does not reject"
// as a first-class, loudly-printed finding rather than a probe failure —
// if duplicates are allowed, receipt strings can't be relied on as an
// idempotency key and the payment-creation design needs a different guard.

import { freshReceipt, loadEnv, logStep, rzpFetch } from './lib.ts'

loadEnv()

interface OrderResponse {
  id: string
  receipt: string
  status: string
}

interface OrderErrorResponse {
  error?: { code?: string; description?: string; [key: string]: unknown }
}

async function createOrder(receipt: string) {
  return rzpFetch<OrderResponse & OrderErrorResponse>('/orders', {
    method: 'POST',
    body: JSON.stringify({ amount: 100, currency: 'INR', receipt, payment_capture: 1 }),
  })
}

async function main() {
  const receipt = freshReceipt('spike-dup')

  const first = await createOrder(receipt)
  logStep('create_order_first', first.ok, first.body)

  const second = await createOrder(receipt)
  logStep('create_order_second', second.ok, second.body)

  const secondBody = second.body as OrderErrorResponse
  const rejectedForReceipt =
    !second.ok &&
    JSON.stringify(secondBody.error ?? {})
      .toLowerCase()
      .includes('receipt')

  if (rejectedForReceipt) {
    logStep('final', true, { verdict: 'RECEIPT_UNIQUENESS_ENFORCED', error: secondBody.error })
    process.exit(0)
  }

  if (second.ok) {
    logStep('final', false, {
      verdict: 'DUPLICATE_ALLOWED',
      warning:
        'Razorpay accepted a second order with the same receipt — receipt strings are NOT a usable idempotency key on this account/mode.',
      secondOrder: second.body,
    })
    console.log('DUPLICATE_ALLOWED: Razorpay did not reject the duplicate receipt.')
    process.exit(1)
  }

  // Rejected, but not obviously for the receipt — surface the raw error so
  // a human can judge whether it's still a uniqueness rejection under a
  // different wording, or something unrelated (e.g. auth, validation).
  logStep('final', false, {
    verdict: 'REJECTED_UNCLEAR_REASON',
    status: second.status,
    body: second.body,
  })
  process.exit(1)
}

main().catch((err) => {
  logStep('fatal', false, { message: err instanceof Error ? err.message : String(err) })
  process.exit(1)
})
