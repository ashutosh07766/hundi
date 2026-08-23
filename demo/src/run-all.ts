#!/usr/bin/env tsx
/**
 * The demo recording script. Boots one facilitator instance (fresh
 * in-memory db) and drives all six stages against it in order, printing each
 * stage's narration and the ledger events it produced, then the ledger's
 * final head hash — the external anchor a viewer can point to after the
 * recording ends. This is the screen-recorded artifact; `stages.md` is its
 * companion script (what to say, what to point at, per-stage seconds
 * budget).
 */

import process from 'node:process'
import { closeStore, createHarness, ledgerHead } from './harness.js'
import { STAGES } from './stages/index.js'
import type { StageOutcome } from './types.js'

function printStage(index: number, ok: boolean, outcome?: StageOutcome, error?: unknown): void {
  const status = ok ? 'PASS' : 'FAIL'
  const title = outcome?.title ?? '(did not complete)'
  console.log('')
  console.log(`── Stage ${index + 1} — ${title} [${status}] ──`)
  if (outcome) {
    console.log(`narration:         ${outcome.narration}`)
    console.log(`expected terminal: ${outcome.expectedTerminal}`)
    console.log(`ledger events:     ${outcome.ledgerEvents.join(' -> ')}`)
  }
  if (!ok) {
    console.log(`error: ${error instanceof Error ? error.message : String(error)}`)
  }
}

async function main(): Promise<void> {
  const harness = await createHarness()
  let passed = 0

  for (let i = 0; i < STAGES.length; i++) {
    const stage = STAGES[i]
    if (!stage) continue
    try {
      const run = await stage(harness)
      passed += 1
      printStage(i, true, run.outcome)
    } catch (err) {
      printStage(i, false, undefined, err)
    }
  }

  console.log('')
  console.log(`${passed}/${STAGES.length} stages passed`)
  console.log(`ledger head hash: ${ledgerHead(harness.db)}`)

  await harness.close()
  await closeStore()

  if (passed !== STAGES.length) process.exitCode = 1
}

main().catch((err) => {
  console.error('demo run-all crashed:', err)
  process.exitCode = 1
})
