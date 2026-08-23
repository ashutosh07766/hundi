#!/usr/bin/env tsx
/**
 * The batch harness runner: drives every task in tasks.ts against one shared
 * facilitator instance (fresh in-memory db, real executor, real verify chain
 * — see setup.ts), grades each one against its own declared oracle
 * (classify.ts), and writes an honest, unedited results table to
 * docs/results.md + docs/results.json.
 *
 * This is the "measured, not cherry-picked" counterpart to the demo script
 * (demo/src/run-all.ts): every task here runs on the deterministic scripted
 * settlement driver, never a real payment rail or a real browser — so unlike
 * a browser-automation harness (whose error budget has to absorb real flake),
 * a mismatch here is never "the rail had a bad day." It is a regression in
 * the facilitator's own logic, and the runner does not hide it inside a
 * passing bucket.
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import type { ClassifyResult } from './classify.js'
import { classifyTaskResult } from './classify.js'
import type { TaskActual } from './run-task.js'
import { runTask } from './run-task.js'
import { closeStore, createHarness, ledgerHead } from './setup.js'
import { TASKS } from './tasks.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, '../../..')
const RESULTS_MD_PATH = resolve(REPO_ROOT, 'docs/results.md')
const RESULTS_JSON_PATH = resolve(REPO_ROOT, 'docs/results.json')

type Row = {
  id: string
  kind: string
  expectedTerminal: string
  actualTerminal: string
  bucket: string
  pass: boolean
  error?: string
}

function formatExpected(expectedTerminal: string, expectedReason: string | undefined): string {
  return expectedReason ? `${expectedTerminal} (${expectedReason})` : expectedTerminal
}

function formatActual(actual: TaskActual | undefined, error: string | undefined): string {
  if (error) return `ERROR: ${error}`
  if (!actual) return '(did not complete)'
  return actual.actualReason
    ? `${actual.actualTerminal} (${actual.actualReason})`
    : actual.actualTerminal
}

function printConsoleTable(rows: Row[]): void {
  console.log('')
  for (const row of rows) {
    const status = row.pass ? 'PASS' : 'MISMATCH'
    console.log(
      `[${status}] ${row.id.padEnd(20)} kind=${row.kind.padEnd(18)} expected=${row.expectedTerminal.padEnd(40)} actual=${row.actualTerminal.padEnd(40)} bucket=${row.bucket}`,
    )
  }
}

function buildMarkdownTable(rows: Row[]): string {
  const header = '| task id | kind | expected | actual | bucket | pass |\n|---|---|---|---|---|---|'
  const body = rows
    .map(
      (r) =>
        `| ${r.id} | ${r.kind} | ${r.expectedTerminal} | ${r.actualTerminal} | ${r.bucket} | ${r.pass ? '✅' : '❌'} |`,
    )
    .join('\n')
  return `${header}\n${body}`
}

async function main(): Promise<void> {
  const startedAt = Date.now()
  const h = await createHarness()

  const rows: Row[] = []
  const bucketCounts: Record<string, number> = {}
  let passed = 0

  for (const task of TASKS) {
    let actual: TaskActual | undefined
    let classification: ClassifyResult | undefined
    let error: string | undefined

    try {
      actual = await runTask(h, task)
      classification = classifyTaskResult(task, actual)
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
      classification = { pass: false, bucket: 'completed-but-undetected' }
    }

    if (classification.pass) passed += 1
    bucketCounts[classification.bucket] = (bucketCounts[classification.bucket] ?? 0) + 1

    rows.push({
      id: task.id,
      kind: task.kind,
      expectedTerminal: formatExpected(task.expectedTerminal, task.expectedReason),
      actualTerminal: formatActual(actual, error),
      bucket: classification.bucket,
      pass: classification.pass,
      ...(error !== undefined ? { error } : {}),
    })
  }

  const wallClockMs = Date.now() - startedAt
  const head = ledgerHead(h.db)

  await h.close()
  await closeStore()

  printConsoleTable(rows)
  const matchRatePct = ((passed / TASKS.length) * 100).toFixed(1)
  console.log('')
  console.log(`${passed}/${TASKS.length} tasks matched their oracle (${matchRatePct}%)`)
  console.log('bucket counts:', JSON.stringify(bucketCounts))
  console.log(`wall clock: ${wallClockMs}ms`)
  console.log(`ledger head hash: ${head}`)

  const mismatches = rows.filter((r) => !r.pass)

  const summaryLines = [
    '# Batch harness results',
    '',
    `Measured on the deterministic scripted settlement driver (see packages/harness/src/setup.ts) — ` +
      `the live Razorpay test-mode rail is proven separately (pay_TTBO5gj6lma2uw, docs/decisions/001-payment-rail.md, 5/5 repeat). ` +
      `Because this driver has no network or browser flake, the expected match rate is 20/20 = 100%: ` +
      `any mismatch below is a real bug in the facilitator, not tolerated as noise.`,
    '',
    '## Results',
    '',
    buildMarkdownTable(rows),
    '',
    '## Summary',
    '',
    `- Tasks: ${TASKS.length}`,
    `- Matched oracle: ${passed} (${matchRatePct}%)`,
    `- Mismatches: ${mismatches.length}${mismatches.length > 0 ? ` — ${mismatches.map((m) => m.id).join(', ')}` : ''}`,
    `- Bucket counts: ${JSON.stringify(bucketCounts)}`,
    `- Wall clock: ${wallClockMs}ms`,
    `- Ledger head hash: \`${head}\``,
    '',
  ]

  await mkdir(dirname(RESULTS_MD_PATH), { recursive: true })
  await writeFile(RESULTS_MD_PATH, `${summaryLines.join('\n')}\n`, 'utf8')
  await writeFile(
    RESULTS_JSON_PATH,
    `${JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        taskCount: TASKS.length,
        matched: passed,
        matchRatePct: Number(matchRatePct),
        bucketCounts,
        wallClockMs,
        ledgerHeadHash: head,
        rows,
      },
      null,
      2,
    )}\n`,
    'utf8',
  )

  if (mismatches.length > 0) process.exitCode = 1
}

main().catch((err) => {
  console.error('harness run crashed:', err)
  process.exitCode = 1
})
