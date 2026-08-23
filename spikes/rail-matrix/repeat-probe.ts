// V14 falsifier: runs the S2S happy-path flow 5x back-to-back with fresh
// receipts each time. A single passing run proves the flow works once; bot
// detection, rate limiting, or account-level friction on repeated automated
// hits only shows up under repeat volume, which is what this probe exists
// to surface.

import { loadEnv, logStep } from './lib.ts'
import { runS2sFlow, type S2sFlowResult } from './s2s-probe.ts'

loadEnv()

const RUN_COUNT = 5

async function main() {
  const results: Array<S2sFlowResult & { run: number }> = []

  for (let run = 1; run <= RUN_COUNT; run++) {
    const runStart = Date.now()
    logStep('repeat_run_start', true, { run, of: RUN_COUNT })
    const result = await runS2sFlow('success@razorpay')
    const runLatencyMs = Date.now() - runStart
    logStep('repeat_run_done', result.outcome === 'captured', { run, runLatencyMs, ...result })
    results.push({ run, ...result })
  }

  const successCount = results.filter((r) => r.outcome === 'captured').length
  const summary = {
    totalRuns: RUN_COUNT,
    successCount,
    failureCount: RUN_COUNT - successCount,
    latenciesMs: results.map((r) => r.latencyMs),
    outcomes: results.map((r) => r.outcome),
  }
  logStep('summary', successCount === RUN_COUNT, summary)
  process.exit(successCount === RUN_COUNT ? 0 : 1)
}

main().catch((err) => {
  logStep('fatal', false, { message: err instanceof Error ? err.message : String(err) })
  process.exit(1)
})
