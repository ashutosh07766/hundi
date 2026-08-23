import type { DemoHarness } from '../harness.js'
import type { StageRun } from '../types.js'
import { runStage1 } from './01-purchase.js'
import { runStage2 } from './02-refusal.js'
import { runStage3 } from './03-gate.js'
import { runStage4 } from './04-injection.js'
import { runStage5 } from './05-failure-recovery.js'
import { runStage6 } from './06-revocation.js'

export { runStage1 } from './01-purchase.js'
export { runStage2 } from './02-refusal.js'
export { runStage3 } from './03-gate.js'
export { runStage4 } from './04-injection.js'
export { runStage5 } from './05-failure-recovery.js'
export { runStage6 } from './06-revocation.js'

/** Canonical stage order — run-all.ts drives these sequentially against one
 * shared harness; the vitest suite runs each against its own fresh harness. */
export const STAGES: ReadonlyArray<(h: DemoHarness) => Promise<StageRun>> = [
  runStage1,
  runStage2,
  runStage3,
  runStage4,
  runStage5,
  runStage6,
]
