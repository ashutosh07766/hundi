/**
 * Grades one task's actual run against its own declared oracle. This is the
 * only place "pass" is decided — a task that doesn't match its oracle always
 * lands in the `completed-but-undetected` quarantine bucket, never in the
 * bucket its `kind` nominally belongs to. That asymmetry is deliberate: it's
 * what keeps this harness from silently rubber-stamping a bug as a pass.
 */

import type { TaskActual } from './run-task.js'
import type { Bucket, Task } from './tasks.js'

export type QuarantineBucket = 'completed-but-undetected'

export type ClassifyResult = {
  pass: boolean
  bucket: Bucket | QuarantineBucket
}

export function classifyTaskResult(task: Task, actual: TaskActual): ClassifyResult {
  const terminalMatches = actual.actualTerminal === task.expectedTerminal
  const reasonMatches =
    task.expectedReason === undefined || actual.actualReason === task.expectedReason
  const matches = terminalMatches && reasonMatches

  return matches
    ? { pass: true, bucket: task.expectedBucket }
    : { pass: false, bucket: 'completed-but-undetected' }
}
