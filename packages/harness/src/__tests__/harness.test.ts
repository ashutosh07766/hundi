/**
 * Two layers of coverage:
 *   - classify.ts's pure comparison logic, exercised directly against
 *     synthetic actual/expected pairs — including a deliberately-wrong oracle,
 *     to prove a mismatch lands in the quarantine bucket rather than being
 *     rubber-stamped as a pass.
 *   - the real 20-task set, run once against a live harness (real facilitator,
 *     real executor, real verify chain, scripted driver) — every task must
 *     match its own oracle. A failure here is a real regression in the
 *     facilitator, not a flaky assertion: the driver is fully deterministic.
 */

import { afterAll, describe, expect, it } from 'vitest'
import { classifyTaskResult } from '../classify.js'
import type { TaskActual } from '../run-task.js'
import { runTask } from '../run-task.js'
import { closeStore, createHarness } from '../setup.js'
import type { Task } from '../tasks.js'
import { TASKS } from '../tasks.js'

function actualFor(overrides: Partial<TaskActual> = {}): TaskActual {
  return {
    actualTerminal: 'captured',
    actualReason: undefined,
    settlementId: 'settlement-fixture',
    events: [],
    ...overrides,
  }
}

describe('classifyTaskResult', () => {
  const happyTask = TASKS.find((t) => t.id === 'happy-1')
  if (!happyTask) throw new Error('fixture task happy-1 missing from TASKS')

  it('passes a task whose actual terminal matches its oracle', () => {
    const result = classifyTaskResult(happyTask, actualFor({ actualTerminal: 'captured' }))
    expect(result).toEqual({ pass: true, bucket: happyTask.expectedBucket })
  })

  it('quarantines a task whose actual terminal does not match its oracle', () => {
    // Same task, wrong outcome — proves a wrong oracle doesn't get rubber-stamped
    // into its "happy" bucket just because the task ran to completion.
    const result = classifyTaskResult(happyTask, actualFor({ actualTerminal: 'rejected' }))
    expect(result).toEqual({ pass: false, bucket: 'completed-but-undetected' })
  })

  it('quarantines a deliberately-wrong oracle even when the state name looks plausible', () => {
    const wrongOracle: Task = {
      ...happyTask,
      id: 'deliberately-wrong-oracle',
      expectedTerminal: 'abandoned', // happy-1 always captures — this oracle is simply false
    }
    const result = classifyTaskResult(wrongOracle, actualFor({ actualTerminal: 'captured' }))
    expect(result.pass).toBe(false)
    expect(result.bucket).toBe('completed-but-undetected')
  })

  it('requires the rejection reason to match when the task declares one', () => {
    const overCapTask = TASKS.find((t) => t.id === 'over-cap-1')
    if (!overCapTask) throw new Error('fixture task over-cap-1 missing from TASKS')

    const rightReason = classifyTaskResult(
      overCapTask,
      actualFor({ actualTerminal: 'blocked-verify', actualReason: 'AMOUNT_EXCEEDS_CEILING' }),
    )
    expect(rightReason.pass).toBe(true)

    const wrongReason = classifyTaskResult(
      overCapTask,
      actualFor({ actualTerminal: 'blocked-verify', actualReason: 'MERCHANT_NOT_IN_SCOPE' }),
    )
    expect(wrongReason.pass).toBe(false)
    expect(wrongReason.bucket).toBe('completed-but-undetected')
  })
})

describe('the real task set, run live', () => {
  afterAll(async () => {
    await closeStore()
  })

  it('has exactly one task per declared id (no accidental duplicates)', () => {
    const ids = TASKS.map((t) => t.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('matches its oracle for all 20 tasks against a live harness — a mismatch here is a real facilitator bug', async () => {
    const h = await createHarness()
    const results = []

    for (const task of TASKS) {
      const actual = await runTask(h, task)
      const classification = classifyTaskResult(task, actual)
      results.push({ task, actual, classification })
    }

    await h.close()

    const mismatches = results.filter((r) => !r.classification.pass)
    if (mismatches.length > 0) {
      const detail = mismatches
        .map(
          (m) =>
            `${m.task.id}: expected ${m.task.expectedTerminal}${m.task.expectedReason ? ` (${m.task.expectedReason})` : ''}, got ${m.actual.actualTerminal}${m.actual.actualReason ? ` (${m.actual.actualReason})` : ''}`,
        )
        .join('; ')
      throw new Error(
        `${mismatches.length}/${TASKS.length} tasks mismatched their oracle: ${detail}`,
      )
    }

    expect(results).toHaveLength(TASKS.length)
    expect(results.every((r) => r.classification.pass)).toBe(true)

    const bucketCounts = new Map<string, number>()
    for (const r of results) {
      bucketCounts.set(
        r.classification.bucket,
        (bucketCounts.get(r.classification.bucket) ?? 0) + 1,
      )
    }
    const total = [...bucketCounts.values()].reduce((sum, n) => sum + n, 0)
    expect(total).toBe(TASKS.length)
  }, 30_000)
})
