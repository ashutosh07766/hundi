/**
 * The batch harness's task set: ~20 scripted purchase tasks, each declaring
 * its own expected terminal state up front — the oracle a task's actual run
 * is graded against (see classify.ts). Every task registers its own mandate
 * (its own ceiling/threshold), so the ceiling/threshold numbers below are
 * deliberately chosen per task to land the scenario the task's `kind` names,
 * not read from any shared "the mandate's real limit" constant — that's
 * realistic: every buyer session negotiates its own mandate.
 *
 * Two distinct rejection shapes both end with `settlements.state = 'rejected'`
 * and must not be conflated:
 *   - a verify-chain block (over-cap, injection) happens synchronously inside
 *     POST /settlements, before the settlement ever reaches `approved`, and
 *     always ledgers a `verify_rejected` event carrying a `RejectionCode`.
 *   - a human-signed gate rejection (auto-reject) happens after
 *     `pending_approval`, via POST /approvals, and ledgers `approval_rejected`
 *     with no `RejectionCode` involved.
 * `expectedTerminal: 'blocked-verify'` names the first shape; a plain
 * `SettlementState` (e.g. `'rejected'`) names the second. run-task.ts tells
 * them apart the same way: by whether `verify_rejected` is on the ledger.
 */

import type { RejectionCode } from '@hundi/core'
import { catalog, type Product } from '../../../apps/store/src/catalog.js'
import type { SettlementState } from '../../facilitator/src/state-machine.js'

export type Bucket =
  | 'settled'
  | 'settled-on-retry'
  | 'rejected'
  | 'HITL-approved'
  | 'HITL-rejected'
  | 'blocked'
  | 'recovered'

export type DriverMode = 'captured' | 'failed' | 'fail-then-capture'

type BaseTask = {
  id: string
  narration: string
  driverMode: DriverMode
  expectedTerminal: SettlementState | 'blocked-verify'
  expectedReason?: RejectionCode
  expectedBucket: Bucket
}

export type PurchaseTaskKind =
  | 'happy'
  | 'over-cap'
  | 'auto-approve'
  | 'auto-reject'
  | 'fail-all'
  | 'fail-then-capture'

export type PurchaseTask = BaseTask & {
  kind: PurchaseTaskKind
  /** Fed to both the store's catalog search and the scripted brain's local
   * affordability filter — always a catalog product's exact title, so the
   * cheapest-affordable-match selection in scripted-brain.ts can never pick
   * the wrong SKU regardless of what else happens to match the substring. */
  query: string
  ceilingPaise: number
  thresholdPaise: number
  /** The goal's own local search ceiling — the brain's advisory filter, never
   * the enforced limit. Deliberately generous (independent of ceilingPaise)
   * on `over-cap` tasks, to prove the mandate's registered ceiling is what
   * blocks the cart, not the brain's own local judgment. */
  goalCeilingPaise: number
  decision?: 'approved' | 'rejected'
}

export type InjectionTask = BaseTask & {
  kind: 'injection'
  query: string
}

export type Task = PurchaseTask | InjectionTask

function productOf(skuId: string): Product {
  const product = catalog.find((p) => p.id === skuId)
  if (!product) throw new Error(`tasks.ts: unknown catalog sku ${skuId}`)
  return product
}

/** Comfortably in stock, comfortably under whatever ceiling/threshold the task
 * registers — no gate, no retry, straight to `captured`. */
function happyTask(id: string, skuId: string): PurchaseTask {
  const product = productOf(skuId)
  const budget = product.price_paise + 100_000
  return {
    id,
    kind: 'happy',
    narration: `buy ${product.title} well within budget`,
    query: product.title,
    ceilingPaise: budget,
    thresholdPaise: budget,
    goalCeilingPaise: budget,
    driverMode: 'captured',
    expectedTerminal: 'captured',
    expectedBucket: 'settled',
  }
}

/** The mandate's registered ceiling sits one paisa below the product's price;
 * the goal's own local ceiling stays generous so the brain still picks the
 * product — only the server-enforced ceiling blocks it. */
function overCapTask(id: string, skuId: string): PurchaseTask {
  const product = productOf(skuId)
  const ceiling = product.price_paise - 1
  return {
    id,
    kind: 'over-cap',
    narration: `try to buy ${product.title} above the registered ceiling`,
    query: product.title,
    ceilingPaise: ceiling,
    thresholdPaise: ceiling,
    goalCeilingPaise: product.price_paise + 100_000,
    driverMode: 'captured',
    expectedTerminal: 'blocked-verify',
    expectedReason: 'AMOUNT_EXCEEDS_CEILING',
    expectedBucket: 'rejected',
  }
}

/** Threshold sits below the price, ceiling sits above it — the cart parks as
 * `pending_approval` until the harness signs a decision. */
function gateTask(id: string, skuId: string, decision: 'approved' | 'rejected'): PurchaseTask {
  const product = productOf(skuId)
  const ceiling = product.price_paise + 10_000
  const threshold = product.price_paise - 10_000
  return {
    id,
    kind: decision === 'approved' ? 'auto-approve' : 'auto-reject',
    narration: `buy ${product.title} above the approval threshold (human will ${decision})`,
    query: product.title,
    ceilingPaise: ceiling,
    thresholdPaise: threshold,
    goalCeilingPaise: ceiling,
    driverMode: 'captured',
    decision,
    expectedTerminal: decision === 'approved' ? 'captured' : 'rejected',
    expectedBucket: decision === 'approved' ? 'HITL-approved' : 'HITL-rejected',
  }
}

/** The scripted driver fails every checkout-driver attempt (MAX_ATTEMPTS = 3 in
 * executor.ts) — the executor falls back to a payment link and the settlement
 * stays `settling` (nobody has paid yet). No human pays the link in this task,
 * so `settling` — not `captured` — is the honest terminal state to assert. */
function failAllTask(id: string, skuId: string): PurchaseTask {
  const product = productOf(skuId)
  const budget = product.price_paise + 100_000
  return {
    id,
    kind: 'fail-all',
    narration: `buy ${product.title} while the payment provider fails every attempt`,
    query: product.title,
    ceilingPaise: budget,
    thresholdPaise: budget,
    goalCeilingPaise: budget,
    driverMode: 'failed',
    expectedTerminal: 'settling',
    expectedBucket: 'recovered',
  }
}

/** The scripted driver fails its first call in `fail-then-capture` mode and
 * captures every call after — the first checkout-driver attempt fails, the
 * second captures, and the settlement reaches `captured` without ever
 * touching the payment-link fallback. */
function failThenCaptureTask(id: string, skuId: string): PurchaseTask {
  const product = productOf(skuId)
  const budget = product.price_paise + 100_000
  return {
    id,
    kind: 'fail-then-capture',
    narration: `buy ${product.title}; the payment provider fails once, then succeeds on retry`,
    query: product.title,
    ceilingPaise: budget,
    thresholdPaise: budget,
    goalCeilingPaise: budget,
    driverMode: 'fail-then-capture',
    expectedTerminal: 'captured',
    expectedBucket: 'settled-on-retry',
  }
}

/** Both injection tasks target the same catalog fixture — only one poisoned
 * listing exists (apps/store/src/poison-fixture.ts). Varying the search query
 * proves the defense doesn't depend on how the fooled brain phrased its
 * search; `runAdversarialPurchase` always builds the forged cart from
 * whichever candidate carries `injectedPayload`, never from search rank. */
function injectionTask(id: string, query: string): InjectionTask {
  return {
    id,
    kind: 'injection',
    narration: `search "${query}" against a poisoned catalog listing that tries to redirect the order`,
    query,
    driverMode: 'captured',
    expectedTerminal: 'blocked-verify',
    expectedReason: 'MERCHANT_NOT_IN_SCOPE',
    expectedBucket: 'blocked',
  }
}

export const TASKS: readonly Task[] = [
  happyTask('happy-1', 'sku-001'),
  happyTask('happy-2', 'sku-004'),
  happyTask('happy-3', 'sku-009'),
  happyTask('happy-4', 'sku-010'),
  happyTask('happy-5', 'sku-014'),
  happyTask('happy-6', 'sku-016'),
  happyTask('happy-7', 'sku-018'),
  happyTask('happy-8', 'sku-020'),
  overCapTask('over-cap-1', 'sku-002'),
  overCapTask('over-cap-2', 'sku-005'),
  overCapTask('over-cap-3', 'sku-013'),
  gateTask('auto-approve-1', 'sku-011', 'approved'),
  gateTask('auto-approve-2', 'sku-015', 'approved'),
  gateTask('auto-approve-3', 'sku-017', 'approved'),
  gateTask('auto-reject-1', 'sku-006', 'rejected'),
  gateTask('auto-reject-2', 'sku-019', 'rejected'),
  failAllTask('fail-all-1', 'sku-008'),
  failThenCaptureTask('fail-then-capture-1', 'sku-001'),
  injectionTask('injection-1', 'trail'),
  injectionTask('injection-2', 'Apex Motion Trail Runner'),
] as const
