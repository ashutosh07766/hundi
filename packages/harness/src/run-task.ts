/**
 * Executes one task against a live `BatchHarness` and reports what actually
 * happened — never what was expected. classify.ts is the only place that
 * compares this output to a task's oracle; this module stays opinion-free
 * about pass/fail.
 */

import { HttpBuyerTools } from '../../../agents/scripted-brain/src/agent-tools.js'
import {
  runAdversarialPurchase,
  runPurchase,
} from '../../../agents/scripted-brain/src/scripted-brain.js'
import { registerMandate } from '../../../agents/scripted-brain/src/session.js'
import { MERCHANT_ID } from '../../../apps/store/src/catalog.js'
import type { SettlementState } from '../../facilitator/src/state-machine.js'
import {
  type BatchHarness,
  DASHBOARD_TOKEN,
  future,
  getSettlement,
  ledgerEventTypesFor,
  postApproval,
  signApprovalDecision,
} from './setup.js'
import type { InjectionTask, PurchaseTask, Task } from './tasks.js'

export type TaskActual = {
  actualTerminal: SettlementState | 'blocked-verify'
  actualReason: string | undefined
  settlementId: string
  events: string[]
}

type SettlementRow = { state: SettlementState; reject_reason: string | null }

/** Reads the settlement's final row + ledger and classifies the terminal shape:
 * a verify-chain block (ledgered as `verify_rejected`, before the settlement
 * ever reaches `approved`) reports as `'blocked-verify'`; anything else reports
 * its raw `SettlementState` — including a human-signed gate rejection, which
 * ledgers `approval_rejected` instead and must not be conflated with a verify
 * block (see tasks.ts's file header). */
async function finalizeSettlement(h: BatchHarness, settlementId: string): Promise<TaskActual> {
  await h.executor.waitForIdle()

  const row = h.db
    .prepare('SELECT state, reject_reason FROM settlements WHERE id = ?')
    .get(settlementId) as SettlementRow
  const events = ledgerEventTypesFor(h.db, settlementId)
  const actualTerminal: SettlementState | 'blocked-verify' = events.includes('verify_rejected')
    ? 'blocked-verify'
    : row.state

  return {
    actualTerminal,
    actualReason: row.reject_reason ?? undefined,
    settlementId,
    events,
  }
}

function setDriverMode(h: BatchHarness, task: Task): void {
  if (task.driverMode === 'fail-then-capture') {
    h.driverController.mode = 'fail-then-capture'
    h.driverController.callCount = 0
    return
  }
  h.driverController.mode = task.driverMode
}

async function runPurchaseTask(h: BatchHarness, task: PurchaseTask): Promise<TaskActual> {
  setDriverMode(h, task)

  const { intent, agentKeyPair } = await registerMandate({
    facilitatorUrl: h.facilitatorUrl,
    dashboardToken: DASHBOARD_TOKEN,
    goal: task.narration,
    ceiling_paise: task.ceilingPaise,
    approval_threshold_paise: task.thresholdPaise,
    merchants: [MERCHANT_ID],
    expires_at: future(),
  })

  const tools = new HttpBuyerTools({ storeUrl: h.storeUrl, facilitatorUrl: h.facilitatorUrl })
  const outcome = await runPurchase(
    {
      goal: {
        query: task.query,
        maxItems: 1,
        ceiling_paise: task.goalCeilingPaise,
        threshold_paise: task.thresholdPaise,
      },
      mandate: { intent, agent: agentKeyPair },
    },
    tools,
    () => {},
  )

  const settlementId =
    outcome.status === 'blocked'
      ? outcome.settlement?.settlement_id
      : outcome.settlement.settlement_id
  if (!settlementId) {
    throw new Error(
      `task ${task.id}: purchase never reached a settlement id (status ${outcome.status})`,
    )
  }

  if (outcome.status === 'pending_approval') {
    if (!task.decision) {
      throw new Error(`task ${task.id}: reached pending_approval with no decision configured`)
    }
    const fetched = await getSettlement(h.facilitatorUrl, settlementId)
    const mandateCartHashHex = fetched.settlement.mandate_cart_hash_hex
    const sig = signApprovalDecision(agentKeyPair, {
      settlementId,
      mandateCartHashHex,
      decision: task.decision,
    })
    await postApproval(h.facilitatorUrl, {
      settlement_id: settlementId,
      mandate_cart_hash_hex: mandateCartHashHex,
      decision: task.decision,
      sig,
    })
  }

  return finalizeSettlement(h, settlementId)
}

async function runInjectionTask(h: BatchHarness, task: InjectionTask): Promise<TaskActual> {
  setDriverMode(h, task)

  const { intent, agentKeyPair } = await registerMandate({
    facilitatorUrl: h.facilitatorUrl,
    dashboardToken: DASHBOARD_TOKEN,
    goal: task.narration,
    // Generous — proves the merchant allowlist, not a ceiling, blocks the forged cart.
    ceiling_paise: 1_000_000,
    approval_threshold_paise: 999_999,
    merchants: [MERCHANT_ID],
    expires_at: future(),
  })

  const tools = new HttpBuyerTools({
    storeUrl: h.storeUrl,
    facilitatorUrl: h.facilitatorUrl,
    poisonedCatalog: true,
  })

  const outcome = await runAdversarialPurchase(
    { goal: { query: task.query }, mandate: { intent, agent: agentKeyPair } },
    tools,
    () => {},
  )

  const settlementId = outcome.settlement?.settlement_id
  if (!settlementId) {
    throw new Error(`task ${task.id}: adversarial purchase never reached a settlement id`)
  }

  return finalizeSettlement(h, settlementId)
}

export async function runTask(h: BatchHarness, task: Task): Promise<TaskActual> {
  return task.kind === 'injection' ? runInjectionTask(h, task) : runPurchaseTask(h, task)
}
