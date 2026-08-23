/**
 * Stage 1 — Purchase (happy path). The agent picks an in-stock, in-budget
 * shoe; the facilitator verifies the mandate chain and settles it straight
 * through to `captured` with no human step (the cart never crosses the
 * approval threshold).
 *
 * Uses the harness's scripted driver (mode `'captured'`) so this stage runs
 * fast and deterministic — it exercises the real facilitator attempt-loop
 * code (packages/facilitator/src/executor.ts), just without a real payment
 * rail behind it. The real rail is proven live and unscripted in
 * packages/facilitator/bin/smoke-settle.ts, which captured a real Razorpay
 * TEST-mode payment (pay_TTBO5gj6lma2uw) through this same executor code —
 * see WHAT-BROKE.md for that run's notes.
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

export type Stage1Detail = { settlementId: string; productId: string; pricePaise: number }

export async function runStage1(h: DemoHarness): Promise<StageRun<Stage1Detail>> {
  h.driverController.mode = 'captured'

  const { intent, agentKeyPair } = await registerMandate({
    facilitatorUrl: h.facilitatorUrl,
    dashboardToken: DASHBOARD_TOKEN,
    goal: 'buy running shoes under the ceiling',
    ceiling_paise: CEILING_PAISE,
    approval_threshold_paise: THRESHOLD_PAISE,
    merchants: [MERCHANT_ID],
    expires_at: future(),
  })

  const tools = new HttpBuyerTools({ storeUrl: h.storeUrl, facilitatorUrl: h.facilitatorUrl })
  const outcome = await runPurchase(
    {
      goal: {
        query: 'Velocity Air Runner',
        maxItems: 1,
        ceiling_paise: CEILING_PAISE,
        threshold_paise: THRESHOLD_PAISE,
      },
      mandate: { intent, agent: agentKeyPair },
    },
    tools,
    () => {},
  )

  if (outcome.status !== 'completed') {
    throw new Error(`stage 1: expected a completed purchase, got ${outcome.status}`)
  }

  const priceRupees = (outcome.product.price_paise / 100).toFixed(0)
  const ceilingRupees = (CEILING_PAISE / 100).toFixed(0)
  const events = ledgerEventTypesFor(h.db, outcome.settlement.settlement_id)

  return {
    outcome: {
      stage: 1,
      title: 'Purchase (happy path)',
      narration: `Agent picked ${outcome.product.title} at ₹${priceRupees}. Verify passed: ₹${priceRupees} ≤ ₹${ceilingRupees}. Charged.`,
      expectedTerminal: 'captured',
      ledgerEvents: events,
    },
    detail: {
      settlementId: outcome.settlement.settlement_id,
      productId: outcome.product.id,
      pricePaise: outcome.product.price_paise,
    },
  }
}
