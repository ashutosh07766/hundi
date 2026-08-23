// Rail (b) building block, not a full driver: proves Payment Links can be
// created and that `reference_id` is enforced as unique. Does not open or
// drive the hosted checkout page — that belongs to a separate
// checkout-driver spike if rail (a) turns out to be blocked.

import { freshReceipt, loadEnv, logStep, rzpFetch } from './lib.ts'

loadEnv()

interface PaymentLinkResponse {
  id: string
  short_url: string
  reference_id?: string
  status: string
}

interface PaymentLinkErrorResponse {
  error?: { code?: string; description?: string; [key: string]: unknown }
}

async function createPaymentLink(referenceId: string) {
  return rzpFetch<PaymentLinkResponse & PaymentLinkErrorResponse>('/payment_links', {
    method: 'POST',
    body: JSON.stringify({
      amount: 100,
      currency: 'INR',
      reference_id: referenceId,
      description: 'spike rail-matrix payment-link probe',
    }),
  })
}

async function main() {
  const referenceId = freshReceipt('spike-pl')

  const first = await createPaymentLink(referenceId)
  logStep('create_payment_link_first', first.ok, first.body)

  if (first.ok) {
    const body = first.body as PaymentLinkResponse
    logStep('payment_link_created', true, { id: body.id, short_url: body.short_url })
  }

  const second = await createPaymentLink(referenceId)
  logStep('create_payment_link_second', second.ok, second.body)

  if (!second.ok && second.status === 400) {
    logStep('final', true, { verdict: 'REFERENCE_ID_UNIQUENESS_ENFORCED', error: second.body })
    process.exit(first.ok ? 0 : 1)
  }

  if (second.ok) {
    logStep('final', false, {
      verdict: 'DUPLICATE_REFERENCE_ID_ALLOWED',
      warning: 'A second payment link with the same reference_id was created without error.',
      secondLink: second.body,
    })
    process.exit(1)
  }

  logStep('final', false, {
    verdict: 'REJECTED_UNEXPECTED_STATUS',
    status: second.status,
    body: second.body,
  })
  process.exit(1)
}

main().catch((err) => {
  logStep('fatal', false, { message: err instanceof Error ? err.message : String(err) })
  process.exit(1)
})
