// Orchestrates the rail (b) checkout-driver spike: start the local checkout
// host page, create a fresh order against Razorpay TEST mode, drive Standard
// Checkout headlessly via `settleViaCheckout`, and print a structured
// verdict. `drive.ts`'s `ok` only means "reached a determinate terminal
// status" — whether that status is the *expected* one is decided here,
// since a --fail run is only a spike success if the payment is cleanly
// detected as failed (clicking Failure on Razorpay's mock bank page).

import { freshReceipt, loadEnv, logStep, rzpFetch } from '../rail-matrix/lib.ts'
import { startCheckoutPageServer } from './checkout-page.ts'
import { type SettleViaCheckoutResult, settleViaCheckout } from './drive.ts'

loadEnv()

const AMOUNT_PAISE = 100

interface OrderResponse {
  id: string
  amount: number
  currency: string
  receipt: string
  status: string
}

interface CliFlags {
  outcome: 'success' | 'failure'
  repeat: number
}

function parseFlags(argv: string[]): CliFlags {
  let outcome: 'success' | 'failure' = 'success'
  let repeat = 1
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--fail') {
      outcome = 'failure'
    } else if (argv[i] === '--repeat') {
      repeat = Number.parseInt(argv[++i] ?? '1', 10) || 1
    }
  }
  return { outcome, repeat }
}

async function createOrder(): Promise<OrderResponse | null> {
  const receipt = freshReceipt('spike-ckd')
  const res = await rzpFetch<OrderResponse>('/orders', {
    method: 'POST',
    body: JSON.stringify({
      amount: AMOUNT_PAISE,
      currency: 'INR',
      receipt,
      payment_capture: 1,
    }),
  })
  logStep('create_order', res.ok, res.body)
  if (!res.ok || !('id' in res.body)) return null
  return res.body as OrderResponse
}

interface RunOutcome extends SettleViaCheckoutResult {
  orderId?: string
  expectedStatus: 'captured' | 'failed'
  matched: boolean
}

async function runOnce(outcome: 'success' | 'failure'): Promise<RunOutcome> {
  const expectedStatus = outcome === 'failure' ? 'failed' : 'captured'
  const order = await createOrder()
  if (!order) {
    return { ok: false, expectedStatus, matched: false, latencyMs: 0, error: 'order_create_failed' }
  }

  const result = await settleViaCheckout({ orderId: order.id, amountPaise: AMOUNT_PAISE, outcome })
  const matched = result.ok && result.status === expectedStatus
  logStep('run_outcome', matched, { orderId: order.id, expectedStatus, ...result })
  return { ...result, orderId: order.id, expectedStatus, matched }
}

async function main() {
  const flags = parseFlags(process.argv.slice(2))
  const server = await startCheckoutPageServer()
  logStep('checkout_page_server_started', true, { port: server.port })

  try {
    const runs: RunOutcome[] = []
    for (let i = 1; i <= flags.repeat; i++) {
      logStep('spike_run_start', true, { run: i, of: flags.repeat, outcome: flags.outcome })
      const outcome = await runOnce(flags.outcome)
      runs.push(outcome)
      logStep('spike_run_done', outcome.matched, {
        run: i,
        of: flags.repeat,
        orderId: outcome.orderId,
        paymentId: outcome.paymentId,
        status: outcome.status,
        detectedVia: outcome.detectedVia,
        signatureVerified: outcome.signatureVerified,
        latencyMs: outcome.latencyMs,
        artifacts: outcome.artifacts,
      })
    }

    const successCount = runs.filter((r) => r.matched).length
    const verdict = {
      outcome: flags.outcome,
      totalRuns: flags.repeat,
      successCount,
      failureCount: flags.repeat - successCount,
      latenciesMs: runs.map((r) => r.latencyMs),
      statuses: runs.map((r) => r.status),
      detectedVia: runs.map((r) => r.detectedVia),
      orderIds: runs.map((r) => r.orderId),
      paymentIds: runs.map((r) => r.paymentId),
      artifacts: runs.filter((r) => r.artifacts).map((r) => r.artifacts),
    }
    logStep('final_verdict', successCount === flags.repeat, verdict)
    process.exit(successCount === flags.repeat ? 0 : 1)
  } finally {
    await server.close()
  }
}

main().catch((err) => {
  logStep('fatal', false, { message: err instanceof Error ? err.message : String(err) })
  process.exit(1)
})
