// Rail (a) failure-injection probe: same S2S UPI collect flow as
// s2s-probe.ts, but with Razorpay's test-mode `failure@razorpay` VPA.
// Success here means the payment reaches status `failed` — proving this
// rail can simulate failed payments, not just happy-path captures. A
// captured or timeout result here is the finding, not a bug in the probe.

import { logStep } from './lib.ts'
import { runS2sFlow } from './s2s-probe.ts'

async function main() {
  const result = await runS2sFlow('failure@razorpay')
  const success = result.outcome === 'failed'
  logStep('final', success, result)
  process.exit(success ? 0 : 1)
}

main().catch((err) => {
  logStep('fatal', false, { message: err instanceof Error ? err.message : String(err) })
  process.exit(1)
})
