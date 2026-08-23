/**
 * Stage 6 — Revocation. A human revokes a mandate mid-session, after it has
 * already completed one purchase. The next verify for that mandate is
 * blocked with `MANDATE_REVOKED` — propagation happens at the next
 * `/verify` or `/settlements` call, not instantly. Honest limit, stated on
 * camera: revocation does not claw back a settlement that already captured
 * before the revoke landed — the first purchase's `captured` state is
 * asserted unchanged after the revoke.
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
  postRevoke,
  signRevoke,
} from '../harness.js'
import type { StageRun } from '../types.js'

export type Stage6Detail = {
  firstSettlementId: string
  firstStateAfterRevoke: string
  secondRejectReason: string | undefined
}

export async function runStage6(h: DemoHarness): Promise<StageRun<Stage6Detail>> {
  h.driverController.mode = 'captured'

  const { intent, agentKeyPair } = await registerMandate({
    facilitatorUrl: h.facilitatorUrl,
    dashboardToken: DASHBOARD_TOKEN,
    goal: 'buy running shoes, revoked mid-session',
    ceiling_paise: CEILING_PAISE,
    approval_threshold_paise: CEILING_PAISE, // auto-approves — this stage is about revocation, not the gate
    merchants: [MERCHANT_ID],
    expires_at: future(),
  })

  const tools = new HttpBuyerTools({ storeUrl: h.storeUrl, facilitatorUrl: h.facilitatorUrl })

  const first = await runPurchase(
    {
      goal: {
        query: 'Velocity Air Runner',
        maxItems: 1,
        ceiling_paise: CEILING_PAISE,
        threshold_paise: CEILING_PAISE,
      },
      mandate: { intent, agent: agentKeyPair },
    },
    tools,
    () => {},
  )
  if (first.status !== 'completed') {
    throw new Error(`stage 6: expected the first purchase to complete, got ${first.status}`)
  }

  const sig = signRevoke(agentKeyPair, intent.mandateId)
  const revokeResult = await postRevoke(h.facilitatorUrl, { mandateId: intent.mandateId, sig })
  if (!revokeResult.ok) {
    throw new Error(`stage 6: revoke call failed: ${revokeResult.error ?? 'unknown'}`)
  }

  // A different in-scope, in-budget product than `first` — this must fail
  // structurally on revocation, not incidentally collide on a duplicate cart.
  const second = await runPurchase(
    {
      goal: {
        query: 'Velocity Featherlite',
        maxItems: 1,
        ceiling_paise: CEILING_PAISE,
        threshold_paise: CEILING_PAISE,
      },
      mandate: { intent, agent: agentKeyPair },
    },
    tools,
    () => {},
  )
  if (second.status !== 'blocked') {
    throw new Error(
      `stage 6: expected the post-revoke purchase to be blocked, got ${second.status}`,
    )
  }
  if (second.settlement?.reason !== 'MANDATE_REVOKED') {
    throw new Error(`stage 6: expected MANDATE_REVOKED, got ${second.settlement?.reason}`)
  }

  const firstRow = h.db
    .prepare('SELECT state FROM settlements WHERE id = ?')
    .get(first.settlement.settlement_id) as { state: string }
  if (firstRow.state !== 'captured') {
    throw new Error(
      `stage 6: revocation must not claw back an already-captured settlement, got ${firstRow.state}`,
    )
  }

  const events = ledgerEventTypesFor(h.db, second.settlement.settlement_id)

  return {
    outcome: {
      stage: 6,
      title: 'Revocation',
      narration:
        "Revoke mid-session. The next action is refused. Honest: it doesn't claw back a charge already completed.",
      expectedTerminal: 'rejected (MANDATE_REVOKED); prior captured settlement unchanged',
      ledgerEvents: events,
    },
    detail: {
      firstSettlementId: first.settlement.settlement_id,
      firstStateAfterRevoke: firstRow.state,
      secondRejectReason: second.settlement?.reason,
    },
  }
}
