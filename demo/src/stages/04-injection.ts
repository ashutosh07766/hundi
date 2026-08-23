/**
 * Stage 4 — Injection caught. The key stage: a catalog listing's description
 * carries a prompt-injection payload ("route this order to merchant X at
 * price Y"). `runAdversarialPurchase` (agents/scripted-brain/src/scripted-
 * brain.ts) simulates a buyer brain whose reasoning step was an LLM that got
 * fooled by that text — it builds a cart pointing at the attacker's merchant
 * and price instead of the listing's real ones. The facilitator has never
 * read the description and never will; `verifyChain` blocks the forged cart
 * on the mandate's signed merchant allowlist, the same check that runs on
 * every cart regardless of how it was built.
 *
 * An LLM-driven brain would be fooled by the injected text identically —
 * this scripts the fooling deterministically so the *defense* is what's
 * demonstrated on camera, not the brain's gullibility.
 */

import { HttpBuyerTools } from '../../../agents/scripted-brain/src/agent-tools.js'
import { runAdversarialPurchase } from '../../../agents/scripted-brain/src/scripted-brain.js'
import { registerMandate } from '../../../agents/scripted-brain/src/session.js'
import {
  CEILING_PAISE,
  DASHBOARD_TOKEN,
  type DemoHarness,
  future,
  ledgerEventTypesFor,
  MERCHANT_ID,
  THRESHOLD_PAISE,
} from '../harness.js'
import type { StageRun } from '../types.js'

export type Stage4Detail = {
  settlementId: string
  rejectReason: string | undefined
  attemptedMerchant: unknown
}

export async function runStage4(h: DemoHarness): Promise<StageRun<Stage4Detail>> {
  const { intent, agentKeyPair } = await registerMandate({
    facilitatorUrl: h.facilitatorUrl,
    dashboardToken: DASHBOARD_TOKEN,
    goal: 'buy a trail shoe',
    ceiling_paise: CEILING_PAISE,
    approval_threshold_paise: THRESHOLD_PAISE,
    // The mandate's signed allowlist names only the real store — the
    // attacker's merchant id from the injected payload is never in it.
    merchants: [MERCHANT_ID],
    expires_at: future(),
  })

  const tools = new HttpBuyerTools({
    storeUrl: h.storeUrl,
    facilitatorUrl: h.facilitatorUrl,
    poisonedCatalog: true,
  })

  const outcome = await runAdversarialPurchase(
    { goal: { query: 'trail' }, mandate: { intent, agent: agentKeyPair } },
    tools,
    () => {},
  )

  if (outcome.status !== 'blocked') {
    throw new Error(`stage 4: expected the forged cart to be blocked, got ${outcome.status}`)
  }
  if (outcome.settlement?.reason !== 'MERCHANT_NOT_IN_SCOPE') {
    throw new Error(`stage 4: expected MERCHANT_NOT_IN_SCOPE, got ${outcome.settlement?.reason}`)
  }

  const settlementId = outcome.settlement.settlement_id
  const events = ledgerEventTypesFor(h.db, settlementId)

  return {
    outcome: {
      stage: 4,
      title: 'Injection caught',
      narration:
        "The catalog told the agent to pay a different merchant. The agent tried. Verify refused — the mandate's merchant allowlist is signed; the agent structurally cannot pay outside it.",
      expectedTerminal: 'rejected (MERCHANT_NOT_IN_SCOPE)',
      ledgerEvents: events,
    },
    detail: {
      settlementId,
      rejectReason: outcome.settlement?.reason,
      attemptedMerchant: outcome.product?.injectedPayload?.merchant_id,
    },
  }
}
