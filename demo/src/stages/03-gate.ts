/**
 * Stage 3 — Gate (human-in-the-loop). A cart above the approval threshold but
 * within the ceiling parks as `pending_approval` instead of settling. Three
 * sub-runs prove the gate is a real state machine, not a UI affordance:
 * a human-signed approval unblocks it to `captured`; a human-signed rejection
 * kills it outright; and — if nobody ever decides — the reconciliation sweep
 * (packages/facilitator/src/sweep.ts) abandons it once its approval TTL
 * elapses, so a settlement can never sit in limbo forever.
 */

import { HttpBuyerTools } from '../../../agents/scripted-brain/src/agent-tools.js'
import type { AgentKeypair } from '../../../agents/scripted-brain/src/ed25519.js'
import { runPurchase } from '../../../agents/scripted-brain/src/scripted-brain.js'
import { registerMandate } from '../../../agents/scripted-brain/src/session.js'
import { createSweep } from '../../../packages/facilitator/src/sweep.js'
import {
  CEILING_PAISE,
  DASHBOARD_TOKEN,
  type DemoHarness,
  future,
  getSettlement,
  ledgerEventTypesFor,
  MERCHANT_ID,
  postApproval,
  signApprovalDecision,
  THRESHOLD_PAISE,
} from '../harness.js'
import type { StageRun } from '../types.js'

// Pace Collective Tempo — above THRESHOLD_PAISE (350_000), within CEILING_PAISE
// (400_000). Picked because it's the catalog's closest in-stock match to that
// band; the exact rupee figure is incidental, the "above threshold, within
// ceiling" band is what the gate cares about.
const GATE_PRODUCT_QUERY = 'Pace Collective Tempo'

type SubflowResult = {
  settlementId: string
  terminalState: string
  rejectReason: string | null
  events: string[]
}

type GatedCart = { settlementId: string; humanKeyPair: AgentKeypair }

async function submitGatedCart(h: DemoHarness, goalLabel: string): Promise<GatedCart> {
  const { intent, agentKeyPair, humanKeyPair } = await registerMandate({
    facilitatorUrl: h.facilitatorUrl,
    dashboardToken: DASHBOARD_TOKEN,
    goal: goalLabel,
    ceiling_paise: CEILING_PAISE,
    approval_threshold_paise: THRESHOLD_PAISE,
    merchants: [MERCHANT_ID],
    expires_at: future(),
  })

  const tools = new HttpBuyerTools({ storeUrl: h.storeUrl, facilitatorUrl: h.facilitatorUrl })
  const outcome = await runPurchase(
    {
      goal: {
        query: GATE_PRODUCT_QUERY,
        maxItems: 1,
        ceiling_paise: CEILING_PAISE,
        threshold_paise: THRESHOLD_PAISE,
      },
      mandate: { intent, agent: agentKeyPair },
    },
    tools,
    () => {},
  )

  if (outcome.status !== 'pending_approval') {
    throw new Error(`stage 3: expected pending_approval, got ${outcome.status}`)
  }
  return { settlementId: outcome.settlement.settlement_id, humanKeyPair }
}

async function runDecisionSubflow(
  h: DemoHarness,
  decision: 'approved' | 'rejected',
): Promise<SubflowResult> {
  const { settlementId, humanKeyPair } = await submitGatedCart(
    h,
    `buy a shoe near the approval threshold (human will ${decision})`,
  )

  const fetched = await getSettlement(h.facilitatorUrl, settlementId)
  const mandateCartHashHex = fetched.settlement.mandate_cart_hash_hex

  // The gate's second factor: only the human key (the registered credential)
  // can sign a valid decision — the agent key that built the cart cannot.
  const sig = signApprovalDecision(humanKeyPair, { settlementId, mandateCartHashHex, decision })
  await postApproval(h.facilitatorUrl, {
    settlement_id: settlementId,
    mandate_cart_hash_hex: mandateCartHashHex,
    decision,
    sig,
  })

  if (decision === 'approved') {
    await h.executor.waitForIdle()
  }

  const row = h.db
    .prepare('SELECT state, reject_reason FROM settlements WHERE id = ?')
    .get(settlementId) as { state: string; reject_reason: string | null }

  return {
    settlementId,
    terminalState: row.state,
    rejectReason: row.reject_reason,
    events: ledgerEventTypesFor(h.db, settlementId),
  }
}

async function runTtlSubflow(h: DemoHarness): Promise<SubflowResult> {
  const { settlementId } = await submitGatedCart(
    h,
    'buy a shoe near the approval threshold (nobody decides)',
  )

  // Nobody ever calls POST /approvals. Instead of a real 30-minute wait, hand
  // the sweep a tiny TTL and a clock that's already past it — the sweep's
  // convergence rule (sweepExpiredApprovals in sweep.ts) doesn't care whether
  // time passed for real or was simulated; it only reads `now()`.
  let clock = Math.floor(Date.now() / 1000)
  const sweep = createSweep({
    db: h.db,
    deps: {
      razorpay: h.razorpay,
      executor: h.executor,
      now: () => clock,
      ttls: { approvalTtlMs: 1_000 },
    },
  })
  clock += 5 // 5 real seconds' worth of simulated time — comfortably past the 1s TTL
  await sweep.runOnce()

  const row = h.db
    .prepare('SELECT state, reject_reason FROM settlements WHERE id = ?')
    .get(settlementId) as { state: string; reject_reason: string | null }

  return {
    settlementId,
    terminalState: row.state,
    rejectReason: row.reject_reason,
    events: ledgerEventTypesFor(h.db, settlementId),
  }
}

export type Stage3Detail = { approve: SubflowResult; reject: SubflowResult; ttl: SubflowResult }

export async function runStage3(h: DemoHarness): Promise<StageRun<Stage3Detail>> {
  h.driverController.mode = 'captured'

  const approve = await runDecisionSubflow(h, 'approved')
  const reject = await runDecisionSubflow(h, 'rejected')
  const ttl = await runTtlSubflow(h)

  if (approve.terminalState !== 'captured') {
    throw new Error(`stage 3 (approve): expected captured, got ${approve.terminalState}`)
  }
  if (reject.terminalState !== 'rejected') {
    throw new Error(`stage 3 (reject): expected rejected, got ${reject.terminalState}`)
  }
  // The sweep's abandon path ledgers the reason (payload.reason ==
  // 'approval_timeout' on the 'approval_expired' event) but doesn't write it
  // to settlements.reject_reason — that column is reserved for verify-chain
  // rejection codes, not sweep-driven abandonment reasons.
  if (ttl.terminalState !== 'abandoned' || !ttl.events.includes('approval_expired')) {
    throw new Error(
      `stage 3 (ttl): expected abandoned with an approval_expired ledger event, got ${ttl.terminalState}/${ttl.events.join(',')}`,
    )
  }

  return {
    outcome: {
      stage: 3,
      title: 'Gate (human-in-the-loop)',
      narration:
        'Above the approval threshold blocks until a human signs. Approval is cryptographic, not a button — and if nobody decides, the sweep abandons it rather than letting it sit forever.',
      expectedTerminal: 'captured (approve) / rejected (reject) / abandoned (approval TTL)',
      ledgerEvents: approve.events,
    },
    detail: { approve, reject, ttl },
  }
}
