/**
 * Stage 2 — Refusal (overspend). The goal's own local search ceiling is
 * generous — the brain has no rule against the product it picks. Only the
 * mandate's registered `ceiling_paise`, enforced server-side by
 * `verifyChain` (packages/core/src/verify.ts), blocks it. This is the
 * distinction the whole system rests on: the agent's local judgment is
 * advisory, the facilitator's check is not.
 */

import { HttpBuyerTools } from '../../../agents/scripted-brain/src/agent-tools.js'
import { runPurchase } from '../../../agents/scripted-brain/src/scripted-brain.js'
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

export type Stage2Detail = { settlementId: string; rejectReason: string | undefined }

export async function runStage2(h: DemoHarness): Promise<StageRun<Stage2Detail>> {
  const { intent, agentKeyPair } = await registerMandate({
    facilitatorUrl: h.facilitatorUrl,
    dashboardToken: DASHBOARD_TOKEN,
    goal: 'buy a shoe, but not above the registered ceiling',
    ceiling_paise: CEILING_PAISE, // the real, server-enforced spending limit
    approval_threshold_paise: THRESHOLD_PAISE,
    merchants: [MERCHANT_ID],
    expires_at: future(),
  })

  const tools = new HttpBuyerTools({ storeUrl: h.storeUrl, facilitatorUrl: h.facilitatorUrl })
  // The goal's local ceiling is generous — it doesn't rule out the product the
  // brain picks. Only the mandate's registered ceiling (above) does.
  const outcome = await runPurchase(
    {
      goal: {
        query: 'Velocity Air Runner Pro',
        maxItems: 1,
        ceiling_paise: 1_000_000,
        threshold_paise: THRESHOLD_PAISE,
      },
      mandate: { intent, agent: agentKeyPair },
    },
    tools,
    () => {},
  )

  if (outcome.status !== 'blocked') {
    throw new Error(`stage 2: expected a blocked purchase, got ${outcome.status}`)
  }
  if (outcome.settlement?.reason !== 'AMOUNT_EXCEEDS_CEILING') {
    throw new Error(`stage 2: expected AMOUNT_EXCEEDS_CEILING, got ${outcome.settlement?.reason}`)
  }

  const settlementId = outcome.settlement.settlement_id
  const cartRupees = ((outcome.product?.price_paise ?? 0) / 100).toFixed(0)
  const ceilingRupees = (CEILING_PAISE / 100).toFixed(0)
  const events = ledgerEventTypesFor(h.db, settlementId)

  return {
    outcome: {
      stage: 2,
      title: 'Refusal (overspend)',
      narration: `Agent picked shoes at ₹${cartRupees} — above the ₹${ceilingRupees} ceiling. The agent cannot exceed the mandate. Not "won't" — can't.`,
      expectedTerminal: 'rejected (AMOUNT_EXCEEDS_CEILING)',
      ledgerEvents: events,
    },
    detail: { settlementId, rejectReason: outcome.settlement?.reason },
  }
}
