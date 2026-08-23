/**
 * The scripted (non-LLM) buyer policy: search, pick the cheapest in-stock match
 * within the goal's own price cap, propose a cart, and hand it to the facilitator.
 * The policy is deliberately dumb — "cheapest that fits" — because the guarantee
 * this brain exists to demonstrate lives in the facilitator's mandate-chain gate,
 * not in the brain's shopping judgment. `goal.ceiling_paise` is only a local search
 * filter the brain trusts to narrow candidates; it is never the real spending
 * limit — only the registered mandate's `ceiling_paise`, enforced server-side by
 * the facilitator, is. A goal with a generous local ceiling and a tightly-scoped
 * mandate is expected to select a product the facilitator then rejects — that is
 * the guardrail working as designed, not a bug in this policy.
 */

import type { IntentMandate } from '@hundi/core'
import type { BuyerTools, Product, SettlementResult } from './agent-tools.js'
import type { AgentKeypair } from './ed25519.js'

export type Goal = {
  query: string
  maxItems: number
  ceiling_paise: number
  threshold_paise: number
}

export type PurchaseMandate = {
  intent: IntentMandate
  agent: AgentKeypair
}

export type PurchaseOutcome =
  | { status: 'completed'; product: Product; settlement: SettlementResult }
  | { status: 'pending_approval'; product: Product; settlement: SettlementResult }
  | { status: 'blocked'; reason: string; product?: Product; settlement?: SettlementResult }

export type LogStep = (step: string, data: Record<string, unknown>) => void

const defaultLog: LogStep = (step, data) => {
  console.log(JSON.stringify({ step, ...data }))
}

/** Runs one purchase attempt against `tools` for `goal`, authorized by `mandate`.
 * Every step is logged as one line of structured JSON so a demo can narrate the
 * run live; `log` defaults to stdout but tests can inject a silent no-op. */
export async function runPurchase(
  { goal, mandate }: { goal: Goal; mandate: PurchaseMandate },
  tools: BuyerTools,
  log: LogStep = defaultLog,
): Promise<PurchaseOutcome> {
  const candidates = await tools.searchCatalog(goal.query)
  log('search', { query: goal.query, resultCount: candidates.length })

  const affordable = candidates
    .filter((p) => p.availability.status === 'in_stock' && p.price_paise <= goal.ceiling_paise)
    .sort((a, b) => a.price_paise - b.price_paise)

  const product = affordable[0]
  if (!product) {
    log('select', { outcome: 'no_candidate' })
    return { status: 'blocked', reason: 'NO_CANDIDATE' }
  }
  log('select', { sku: product.id, title: product.title, price_paise: product.price_paise })

  const cart = tools.proposeCart([{ product, qty: 1 }])
  log('propose_cart', { merchant_id: cart.merchant_id, total_paise: cart.total_paise })

  const willLikelyNeedApproval = cart.total_paise > goal.threshold_paise
  log('request_payment', { willLikelyNeedApproval })
  const settlement = await tools.requestPayment({
    intent: mandate.intent,
    cart,
    agent: mandate.agent,
  })
  log('settlement_created', {
    settlement_id: settlement.settlement_id,
    state: settlement.state,
    reason: settlement.reason ?? null,
  })

  if (settlement.state === 'pending_approval' && tools.recordDecision) {
    try {
      await tools.recordDecision({
        settlementId: settlement.settlement_id,
        payload: {
          rationale: 'cheapest in-stock match under the goal ceiling',
          sku: product.id,
          price_paise: product.price_paise,
        },
        agent: mandate.agent,
      })
      log('decision_rationale', { posted: true, settlement_id: settlement.settlement_id })
    } catch (err) {
      log('decision_rationale', {
        posted: false,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  const outcome = toOutcome(settlement, product)
  log('outcome', outcome)
  return outcome
}

function toOutcome(settlement: SettlementResult, product: Product): PurchaseOutcome {
  if (settlement.state === 'captured') return { status: 'completed', product, settlement }
  if (settlement.state === 'pending_approval') {
    return { status: 'pending_approval', product, settlement }
  }
  return { status: 'blocked', reason: settlement.reason ?? settlement.state, product, settlement }
}
