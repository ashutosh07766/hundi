// Route spike probe 2/3: given a captured TEST-mode payment, can we split
// settlement to a linked ("Route") account via the Transfers API? This is
// the half of Route that actually answers "does the merchant get paid" —
// linked-account creation alone doesn't move money.
//
// Takes an optional `acc_...` linked-account id as argv[2] (chain from
// linked-account-probe.ts's `ROUTE_ACCOUNT_ID=` output line). When omitted,
// runs with a syntactically-valid but non-existent placeholder id so the
// probe still exercises both transfer endpoints and captures their error
// shape — a rejection naming the *account* ("account does not exist") is a
// different, more useful signal than a rejection naming the *feature*
// ("route not enabled"), and this run distinguishes the two even with zero
// real linked accounts on the test account.
//
// Tries two contracts, since Razorpay documents both for TEST mode:
//   1. `POST /payments/:id/transfers` — split an existing captured payment.
//   2. `POST /transfers` — direct transfer from the account balance, no
//      source payment required.

import { loadEnv, logStep, rzpFetch } from '../rail-matrix/lib.ts'

loadEnv()

const PLACEHOLDER_ACCOUNT_ID = 'acc_ROUTESPIKEPLACEHOLDER'

interface PaymentsListItem {
  id: string
  status: string
  amount: number
  currency: string
  [key: string]: unknown
}

interface PaymentsListResponse {
  entity: string
  count: number
  items: PaymentsListItem[]
}

interface TransferResponse {
  id?: string
  entity?: string
  items?: unknown[]
  error?: { code?: string; description?: string; reason?: string; field?: string; [key: string]: unknown }
  [key: string]: unknown
}

async function findCapturedPayment(): Promise<PaymentsListItem | undefined> {
  const res = await rzpFetch<PaymentsListResponse>('/payments?count=10')
  logStep('list_payments', res.ok, res.ok ? { count: (res.body as PaymentsListResponse).count } : res.body)
  if (!res.ok || !('items' in res.body)) return undefined
  return (res.body as PaymentsListResponse).items.find((p) => p.status === 'captured')
}

async function tryPaymentTransfer(paymentId: string, accountId: string) {
  const res = await rzpFetch<TransferResponse>(`/payments/${paymentId}/transfers`, {
    method: 'POST',
    body: JSON.stringify({
      transfers: [
        {
          account: accountId,
          amount: 100,
          currency: 'INR',
          on_hold: false,
        },
      ],
    }),
  })
  logStep('payment_transfer', res.ok, res.body)
  return res
}

async function tryDirectTransfer(accountId: string) {
  const res = await rzpFetch<TransferResponse>('/transfers', {
    method: 'POST',
    body: JSON.stringify({
      account: accountId,
      amount: 100,
      currency: 'INR',
    }),
  })
  logStep('direct_transfer', res.ok, res.body)
  return res
}

async function main() {
  const accountId = process.argv[2] ?? PLACEHOLDER_ACCOUNT_ID
  const usingPlaceholder = accountId === PLACEHOLDER_ACCOUNT_ID
  logStep('run_config', true, { accountId, usingPlaceholder })

  const captured = await findCapturedPayment()
  let paymentTransferResult: Awaited<ReturnType<typeof tryPaymentTransfer>> | undefined

  if (captured) {
    logStep('found_captured_payment', true, { id: captured.id, amount: captured.amount })
    paymentTransferResult = await tryPaymentTransfer(captured.id, accountId)
  } else {
    logStep('found_captured_payment', false, {
      note: 'no captured payment in the last 10 — run rail-matrix/s2s-probe.ts first for a real payment id',
    })
  }

  const directResult = await tryDirectTransfer(accountId)

  const paymentTransferWorked = paymentTransferResult?.ok === true
  const directTransferWorked = directResult.ok === true

  if (paymentTransferWorked || directTransferWorked) {
    logStep('final', true, {
      verdict: 'TRANSFER_SUCCEEDED',
      paymentTransferWorked,
      directTransferWorked,
      usingPlaceholder,
    })
    process.exit(0)
  }

  logStep('final', false, {
    verdict: 'GATED_OR_BLOCKED',
    usingPlaceholder,
    paymentTransferStatus: paymentTransferResult?.status,
    paymentTransferBody: paymentTransferResult?.body,
    directTransferStatus: directResult.status,
    directTransferBody: directResult.body,
  })
  process.exit(1)
}

main().catch((err) => {
  logStep('fatal', false, { message: err instanceof Error ? err.message : String(err) })
  process.exit(1)
})
