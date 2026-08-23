/**
 * The Claude-driven buyer policy: search, hand the candidate list to Claude for a
 * reasoned pick, then run the exact same propose-cart / request-payment sequence
 * the scripted brain uses. This module changes only *which* product gets chosen —
 * `BuyerTools` is the entire capability surface available to it, so the money path
 * (cart signing, facilitator submission, polling) is byte-identical to the
 * scripted brain's. Swapping this brain in never grants a new capability.
 *
 * Claude only ever sees structured catalog fields (id/title/description/
 * price_paise/availability/brand) — never `injectedPayload` (see `Product` in
 * agent-tools.ts) — but that omission is defense in depth, not the real guard.
 * The real guard is structural: `resolveChoice` below only ever builds a cart from
 * a listing's own `price_paise`/`merchant_id` (via `tools.proposeCart`), so even a
 * Claude call fully fooled by adversarial description text can't smuggle an
 * attacker-controlled price or merchant into the cart the way
 * `runAdversarialPurchase` in scripted-brain.ts deliberately does. A pick that
 * fails validation (unknown sku, out of stock, over the goal's local ceiling)
 * never reaches `proposeCart` — it's replaced by the scripted brain's own
 * cheapest-in-stock-under-ceiling rule before any cart is built.
 */

import type { BuyerTools, Product, SettlementResult } from '../../scripted-brain/src/agent-tools.js'
import type { AgentKeypair } from '../../scripted-brain/src/ed25519.js'
import type {
  LogStep,
  PurchaseMandate,
  PurchaseOutcome,
} from '../../scripted-brain/src/scripted-brain.js'

export type ClaudeGoal = {
  query: string
  ceiling_paise: number
  threshold_paise: number
}

export type ClaudePurchaseArgs = {
  goal: ClaudeGoal
  mandate: PurchaseMandate
  model?: string
}

/** The minimal slice of the `@anthropic-ai/sdk` client this module calls —
 * narrow enough that tests can inject a fake without booting a real SDK client,
 * wide enough that a real `Anthropic` instance's `.messages` satisfies it as-is. */
export type AnthropicClient = {
  messages: {
    create(params: {
      model: string
      max_tokens: number
      messages: Array<{ role: 'user'; content: string }>
    }): Promise<{ content: Array<{ type: string; text?: string }> }>
  }
}

export type ClaudeBrainDeps = {
  anthropic: AnthropicClient
  log?: LogStep
}

export const DEFAULT_MODEL = 'claude-haiku-4-5-20251001'

const defaultLog: LogStep = (step, data) => {
  console.log(JSON.stringify({ step, ...data }))
}

type ClaudePick = { chosen_sku: string; reason: string }

/** Every reason `resolveChoice` can fall back to the scripted rule for — logged
 * verbatim so a demo transcript shows exactly why an override happened. */
type GuardrailOverrideReason =
  | 'NO_CLAUDE_PICK'
  | 'SKU_NOT_IN_CANDIDATES'
  | 'OUT_OF_STOCK'
  | 'OVER_CEILING'

type ResolvedChoice = {
  product: Product | undefined
  overridden: boolean
  overrideReason?: GuardrailOverrideReason
  claudeReason?: string
}

/** Runs one Claude-brain purchase attempt against `tools` for `goal`, authorized
 * by `mandate`. Mirrors `runPurchase` in scripted-brain.ts step-for-step (same
 * log step names, same `PurchaseOutcome` shape) so a harness or demo can swap
 * brains without touching call sites — only the `select` step's reasoning
 * differs. */
export async function runClaudePurchase(
  { goal, mandate, model = DEFAULT_MODEL }: ClaudePurchaseArgs,
  tools: BuyerTools,
  deps: ClaudeBrainDeps,
): Promise<PurchaseOutcome> {
  const log = deps.log ?? defaultLog

  const candidates = await tools.searchCatalog(goal.query)
  log('search', { query: goal.query, resultCount: candidates.length })

  const pick = await askClaude(deps.anthropic, model, goal, candidates)
  const resolved = resolveChoice(pick, candidates, goal, log)

  const { product } = resolved
  if (!product) {
    log('select', { outcome: 'no_candidate' })
    return { status: 'blocked', reason: 'NO_CANDIDATE' }
  }
  log('select', {
    sku: product.id,
    title: product.title,
    price_paise: product.price_paise,
    claude_reason: resolved.claudeReason ?? null,
    overridden: resolved.overridden,
    override_reason: resolved.overrideReason ?? null,
  })

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
    await recordRationale(tools, settlement, product, resolved, mandate.agent, log)
  }

  const outcome = toOutcome(settlement, product)
  log('outcome', outcome)
  return outcome
}

async function recordRationale(
  tools: BuyerTools,
  settlement: SettlementResult,
  product: Product,
  resolved: ResolvedChoice,
  agent: AgentKeypair,
  log: LogStep,
): Promise<void> {
  const rationale = resolved.overridden
    ? `guardrail override (${resolved.overrideReason}): fell back to cheapest in-stock match under the goal ceiling`
    : (resolved.claudeReason ?? 'Claude selection')
  try {
    await tools.recordDecision?.({
      settlementId: settlement.settlement_id,
      payload: { rationale, sku: product.id, price_paise: product.price_paise },
      agent,
    })
    log('decision_rationale', { posted: true, settlement_id: settlement.settlement_id })
  } catch (err) {
    log('decision_rationale', {
      posted: false,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

/** Asks Claude to pick one product from the full candidate list (in stock or
 * not — the guardrail below is what actually enforces stock/price, not the
 * prompt) and return `{chosen_sku, reason}`. Returns `undefined` on any
 * malformed or missing response; callers must always fall back rather than
 * trust an unparsed pick. */
async function askClaude(
  anthropic: AnthropicClient,
  model: string,
  goal: ClaudeGoal,
  candidates: Product[],
): Promise<ClaudePick | undefined> {
  const response = await anthropic.messages.create({
    model,
    max_tokens: 300,
    messages: [{ role: 'user', content: buildPrompt(goal, candidates) }],
  })
  const text = response.content.find((block) => block.type === 'text')?.text
  return text ? parseClaudePick(text) : undefined
}

function buildPrompt(goal: ClaudeGoal, candidates: Product[]): string {
  const listing = candidates.map((p) => ({
    id: p.id,
    title: p.title,
    description: p.description,
    price_paise: p.price_paise,
    availability: p.availability.status,
    brand: p.brand,
  }))
  return [
    `A shopper wants: "${goal.query}"`,
    `Their maximum budget is ${goal.ceiling_paise} paise.`,
    'Pick the single best-fitting product from this candidate list (JSON array):',
    JSON.stringify(listing),
    'Respond with ONLY a JSON object of the shape {"chosen_sku": string, "reason": string} — ' +
      'no markdown, no other text. "reason" is one sentence explaining the fit.',
  ].join('\n')
}

function parseClaudePick(text: string): ClaudePick | undefined {
  const match = text.match(/\{[\s\S]*\}/)
  if (!match) return undefined
  try {
    const parsed: unknown = JSON.parse(match[0])
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'chosen_sku' in parsed &&
      'reason' in parsed &&
      typeof (parsed as Record<string, unknown>).chosen_sku === 'string' &&
      typeof (parsed as Record<string, unknown>).reason === 'string'
    ) {
      return {
        chosen_sku: (parsed as ClaudePick).chosen_sku,
        reason: (parsed as ClaudePick).reason,
      }
    }
    return undefined
  } catch {
    return undefined
  }
}

/** cheapest in-stock match under the goal's local ceiling — the same rule
 * scripted-brain.ts's runPurchase uses. Both brains converge on identical
 * behavior when Claude's pick fails validation or never arrives. */
function fallbackPick(candidates: Product[], ceiling_paise: number): Product | undefined {
  return candidates
    .filter((p) => p.availability.status === 'in_stock' && p.price_paise <= ceiling_paise)
    .sort((a, b) => a.price_paise - b.price_paise)[0]
}

/** Validates Claude's pick against the real candidate list before it's allowed
 * anywhere near `proposeCart`. Any failure here — unknown sku, out of stock,
 * over the local ceiling, or no parseable pick at all — replaces the pick with
 * `fallbackPick` and records why. */
function resolveChoice(
  pick: ClaudePick | undefined,
  candidates: Product[],
  goal: ClaudeGoal,
  log: LogStep,
): ResolvedChoice {
  if (!pick) {
    return override('NO_CLAUDE_PICK', candidates, goal, log)
  }

  const chosen = candidates.find((p) => p.id === pick.chosen_sku)
  if (!chosen) {
    return override('SKU_NOT_IN_CANDIDATES', candidates, goal, log, pick)
  }
  if (chosen.availability.status !== 'in_stock') {
    return override('OUT_OF_STOCK', candidates, goal, log, pick)
  }
  if (chosen.price_paise > goal.ceiling_paise) {
    return override('OVER_CEILING', candidates, goal, log, pick)
  }
  return { product: chosen, overridden: false, claudeReason: pick.reason }
}

function override(
  reason: GuardrailOverrideReason,
  candidates: Product[],
  goal: ClaudeGoal,
  log: LogStep,
  pick?: ClaudePick,
): ResolvedChoice {
  log('guardrail_override', { reason, claude_chosen_sku: pick?.chosen_sku ?? null })
  const product = fallbackPick(candidates, goal.ceiling_paise)
  return pick?.reason === undefined
    ? { product, overridden: true, overrideReason: reason }
    : { product, overridden: true, overrideReason: reason, claudeReason: pick.reason }
}

function toOutcome(settlement: SettlementResult, product: Product): PurchaseOutcome {
  if (settlement.state === 'captured') return { status: 'completed', product, settlement }
  if (settlement.state === 'pending_approval') {
    return { status: 'pending_approval', product, settlement }
  }
  return { status: 'blocked', reason: settlement.reason ?? settlement.state, product, settlement }
}
