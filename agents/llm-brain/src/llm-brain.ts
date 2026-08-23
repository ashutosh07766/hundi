/**
 * The provider-agnostic LLM buyer policy: search, hand the candidate list to
 * whichever OpenAI-compatible chat model is configured for a reasoned pick,
 * then run the exact same propose-cart / request-payment sequence the
 * scripted and Claude brains use. This module changes only *which* product
 * gets chosen — `BuyerTools` is the entire capability surface available to
 * it, so the money path (cart signing, facilitator submission, polling) is
 * byte-identical across every brain. Swapping this brain in never grants a
 * new capability, and swapping the LLM provider underneath it (Groq, Gemini,
 * OpenRouter, Ollama, ...) never changes this module at all.
 *
 * The model only ever sees structured catalog fields (id/title/description/
 * price_paise/availability/brand) — never `injectedPayload` (see `Product` in
 * agent-tools.ts) — but that omission is defense in depth, not the real
 * guard. The real guard is structural: `resolveChoice` below only ever builds
 * a cart from a listing's own `price_paise`/`merchant_id` (via
 * `tools.proposeCart`), so even a model call fully fooled by adversarial
 * description text can't smuggle an attacker-controlled price or merchant
 * into the cart. A pick that fails validation (unknown sku, out of stock,
 * over the goal's local ceiling) never reaches `proposeCart` — it's replaced
 * by the same cheapest-in-stock-under-ceiling rule the scripted brain uses,
 * before any cart is built.
 */

import type { BuyerTools, Product, SettlementResult } from '../../scripted-brain/src/agent-tools.js'
import type { AgentKeypair } from '../../scripted-brain/src/ed25519.js'
import type {
  LogStep,
  PurchaseMandate,
  PurchaseOutcome,
} from '../../scripted-brain/src/scripted-brain.js'
import { chatJson } from './llm-client.js'

export type LlmGoal = {
  query: string
  ceiling_paise: number
  threshold_paise: number
}

export type LlmConfig = {
  baseUrl: string
  apiKey: string
  model: string
}

export type LlmPurchaseArgs = {
  goal: LlmGoal
  mandate: PurchaseMandate
  config?: LlmConfig
}

/** The minimal surface `runLlmPurchase` calls — narrow enough that tests can
 * inject a fake without a real HTTP round trip, wide enough that the default
 * client built from `LlmConfig` (a thin wrapper over `chatJson`) satisfies it
 * as-is. */
export type ChatClient = {
  chatJson(args: {
    system: string
    user: string
  }): Promise<{ chosen_sku?: string; reason?: string; chosen_variant_id?: string }>
}

export type LlmBrainDeps = {
  /** Overrides the default OpenAI-compatible client — tests inject a fake
   * here so no fetch ever happens. When omitted, `config` is required and a
   * real client is built from it. */
  chat?: ChatClient
  log?: LogStep
}

const defaultLog: LogStep = (step, data) => {
  console.log(JSON.stringify({ step, ...data }))
}

type LlmPick = { chosen_sku: string; reason: string; chosen_variant_id?: string }

/** Every reason `resolveChoice` can fall back to the scripted rule for —
 * logged verbatim so a demo transcript shows exactly why an override
 * happened. `VARIANT_NOT_FOUND` is distinct from the others: it never falls
 * back to a substitute product (see `resolveChoice`) — a shopper who asked for
 * a specific size that doesn't exist would rather be told than be sold a
 * different product entirely. */
export type GuardrailOverrideReason =
  | 'NO_LLM_PICK'
  | 'SKU_NOT_IN_CANDIDATES'
  | 'OUT_OF_STOCK'
  | 'OVER_CEILING'
  | 'VARIANT_NOT_FOUND'

type ResolvedChoice = {
  product: Product | undefined
  overridden: boolean
  overrideReason?: GuardrailOverrideReason
  llmReason?: string
  variantId?: string
  variantLabel?: string
}

/** Narrower than `LlmGoal` — just what the selection step (as opposed to the
 * full purchase flow) needs. `threshold_paise` only matters after a product
 * is already chosen (it decides whether the cart needs human approval), so
 * callers that only want a recommendation — like the facilitator's
 * /agent/select — never have to invent one. */
export type ChooseProductGoal = { query: string; ceiling_paise: number }

export type ChooseProductArgs = {
  candidates: Product[]
  goal: ChooseProductGoal
  chat: ChatClient
  log?: LogStep
}

export type ChooseProductResult = {
  product?: Product
  chosen_sku?: string
  /** The resolved variant's id/label, present only when the goal named a size/
   * color that matched one of the chosen product's real variants. */
  chosen_variant_id?: string
  variant_label?: string
  reason?: string
  overridden: boolean
  override_reason?: GuardrailOverrideReason
}

/** Runs one LLM-brain purchase attempt against `tools` for `goal`, authorized
 * by `mandate`. Mirrors `runPurchase` in scripted-brain.ts step-for-step
 * (same log step names, same `PurchaseOutcome` shape) so a harness or demo
 * can swap brains without touching call sites — only the `select` step's
 * reasoning differs. */
export async function runLlmPurchase(
  { goal, mandate, config }: LlmPurchaseArgs,
  tools: BuyerTools,
  deps: LlmBrainDeps = {},
): Promise<PurchaseOutcome> {
  const log = deps.log ?? defaultLog
  const chat = deps.chat ?? buildDefaultChatClient(config)

  // Hand the LLM the full catalog and let IT judge relevance to the goal — the
  // whole point of an LLM brain. A substring pre-filter on the goal text (the
  // scripted brain's approach) would hide the very products the model should
  // reason over (e.g. goal "leather sneakers for men" matches no title verbatim).
  const candidates = await tools.searchCatalog()
  log('search', { query: goal.query, resultCount: candidates.length })

  const choice = await chooseProduct({ candidates, goal, chat, log })

  const { product } = choice
  if (!product) {
    log('select', { outcome: 'no_candidate' })
    return { status: 'blocked', reason: 'NO_CANDIDATE' }
  }
  log('select', {
    sku: product.id,
    title: product.title,
    price_paise: product.price_paise,
    llm_reason: choice.reason ?? null,
    overridden: choice.overridden,
    override_reason: choice.override_reason ?? null,
    chosen_variant_id: choice.chosen_variant_id ?? null,
    variant_label: choice.variant_label ?? null,
  })

  const cart = tools.proposeCart([
    {
      product,
      qty: 1,
      ...(choice.chosen_variant_id ? { variantId: choice.chosen_variant_id } : {}),
    },
  ])
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
    await recordRationale(tools, settlement, product, choice, mandate.agent, log)
  }

  const outcome = toOutcome(settlement, product)
  log('outcome', outcome)
  return outcome
}

/** Builds a `ChatClient` from `{baseUrl,apiKey,model}`, deferring the
 * `chatJson` call (and thus any I/O) until a purchase actually asks for a
 * pick. Exported so any caller that wants the real OpenAI-compatible client —
 * `runLlmPurchase` itself, or an external caller of `chooseProduct` like the
 * facilitator's /agent/select — doesn't have to re-implement this wiring.
 * `config` undefined throws immediately rather than silently degrading to
 * some default endpoint; there is no safe default provider to fall back to. */
export function buildDefaultChatClient(config: LlmConfig | undefined): ChatClient {
  if (!config) {
    throw new Error('either deps.chat or config (baseUrl/apiKey/model) is required')
  }
  return {
    chatJson: (args) => chatJson({ ...config, ...args }),
  }
}

/** The pure product-selection step shared by `runLlmPurchase` and any other
 * caller that only needs a recommendation, not a full purchase — e.g. the
 * facilitator's /agent/select, which advises a dashboard-held agent key
 * rather than spending anything itself. Runs the model's pick through the
 * same validation `runLlmPurchase` always has: an unknown sku, an
 * out-of-stock sku, or a sku over the goal's ceiling never reaches the
 * caller — it's replaced by the cheapest in-stock match under the ceiling,
 * flagged via `overridden`/`override_reason` so the caller can disclose the
 * fallback instead of presenting it as the model's own reasoning. */
export async function chooseProduct({
  candidates,
  goal,
  chat,
  log = () => {},
}: ChooseProductArgs): Promise<ChooseProductResult> {
  const pick = await askLlm(chat, goal, candidates)
  const resolved = resolveChoice(pick, candidates, goal, log)
  return {
    ...(resolved.product ? { product: resolved.product, chosen_sku: resolved.product.id } : {}),
    ...(resolved.variantId
      ? { chosen_variant_id: resolved.variantId, variant_label: resolved.variantLabel }
      : {}),
    ...(resolved.llmReason !== undefined ? { reason: resolved.llmReason } : {}),
    overridden: resolved.overridden,
    ...(resolved.overrideReason ? { override_reason: resolved.overrideReason } : {}),
  }
}

async function recordRationale(
  tools: BuyerTools,
  settlement: SettlementResult,
  product: Product,
  choice: ChooseProductResult,
  agent: AgentKeypair,
  log: LogStep,
): Promise<void> {
  const rationale = choice.overridden
    ? `guardrail override (${choice.override_reason}): fell back to cheapest in-stock match under the goal ceiling`
    : (choice.reason ?? 'LLM selection')
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

/** Asks the model to pick one product from the full candidate list (in stock
 * or not — the guardrail below is what actually enforces stock/price, not
 * the prompt) and return `{chosen_sku, reason}`, plus `chosen_variant_id` when
 * the goal named a size/color. Returns `undefined` on any malformed or missing
 * response; callers must always fall back rather than trust an unparsed pick. */
async function askLlm(
  chat: ChatClient,
  goal: ChooseProductGoal,
  candidates: Product[],
): Promise<LlmPick | undefined> {
  const { system, user } = buildPrompt(goal, candidates)
  const pick = await chat.chatJson({ system, user })
  if (!pick.chosen_sku) return undefined
  return {
    chosen_sku: pick.chosen_sku,
    reason: pick.reason ?? '',
    ...(pick.chosen_variant_id ? { chosen_variant_id: pick.chosen_variant_id } : {}),
  }
}

/** Cap candidates sent to the LLM so a large real-store catalog (e.g. 200+
 * Shopify products) stays under free-tier request-token limits. In-stock,
 * within-budget items are prioritized so the cap never hides a valid pick. */
const MAX_LLM_CANDIDATES = 90

function buildPrompt(
  goal: ChooseProductGoal,
  candidates: Product[],
): { system: string; user: string } {
  const ranked = [...candidates].sort((a, b) => {
    const aOk = a.availability.status === 'in_stock' && a.price_paise <= goal.ceiling_paise
    const bOk = b.availability.status === 'in_stock' && b.price_paise <= goal.ceiling_paise
    if (aOk !== bOk) return aOk ? -1 : 1
    return 0
  })
  // Title + price + brand only — descriptions balloon the prompt ~2x and blow
  // the free-tier token limit; title/brand carry enough signal to pick by goal.
  // `variants` is included only when the product actually has size/color choices,
  // so a single-SKU listing's prompt entry stays exactly as small as before.
  const listing = ranked.slice(0, MAX_LLM_CANDIDATES).map((p) => ({
    id: p.id,
    title: p.title,
    price_paise: p.price_paise,
    availability: p.availability.status,
    brand: p.brand,
    ...(p.variants
      ? {
          variants: p.variants.map((v) => ({
            variant_id: v.variant_id,
            label: v.label,
            available: v.available,
          })),
        }
      : {}),
  }))
  const system =
    'You are a careful shopping assistant. Pick the single best-fitting product for the ' +
    "shopper's stated goal from a JSON candidate list. Respond with ONLY a JSON object of " +
    'the shape {"chosen_sku": string, "reason": string, "chosen_variant_id": string} — no ' +
    'markdown, no other text. "reason" is one sentence explaining the fit. If the goal names a ' +
    'size or color, the chosen product has a "variants" list, and one of its variants matches, ' +
    'set "chosen_variant_id" to that variant\'s id. Omit "chosen_variant_id" entirely when the ' +
    'goal names no size/color, or when the chosen product has no "variants" list at all — never ' +
    'invent a variant id that isn\'t in the candidate\'s own "variants" list.'
  const user = [
    `Shopper goal: "${goal.query}"`,
    `Maximum budget: ${goal.ceiling_paise} paise.`,
    `Candidates: ${JSON.stringify(listing)}`,
  ].join('\n')
  return { system, user }
}

/** cheapest in-stock match under the goal's local ceiling — the same rule
 * scripted-brain.ts's runPurchase uses. Every brain converges on identical
 * behavior when the LLM's pick fails validation or never arrives. */
export function fallbackPick(candidates: Product[], ceiling_paise: number): Product | undefined {
  return candidates
    .filter((p) => p.availability.status === 'in_stock' && p.price_paise <= ceiling_paise)
    .sort((a, b) => a.price_paise - b.price_paise)[0]
}

/** Validates the model's pick against the real candidate list before it's
 * allowed anywhere near `proposeCart`. Any failure here — unknown sku, out of
 * stock, over the local ceiling, or no parseable pick at all — replaces the
 * pick with `fallbackPick` and records why. */
function resolveChoice(
  pick: LlmPick | undefined,
  candidates: Product[],
  goal: ChooseProductGoal,
  log: LogStep,
): ResolvedChoice {
  if (!pick) {
    return override('NO_LLM_PICK', candidates, goal, log)
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

  if (pick.chosen_variant_id) {
    const variant = chosen.variants?.find((v) => v.variant_id === pick.chosen_variant_id)
    if (!variant) {
      // Deliberately NOT `override(...)`: that helper substitutes a *different*
      // product via fallbackPick, which would silently sell the shopper the wrong
      // size's worth of a product they didn't ask for. A named-but-nonexistent
      // variant is disclosed (overridden:true, override_reason) with no product at
      // all, so the caller treats it as a blocked pick rather than a substitution.
      log('guardrail_override', {
        reason: 'VARIANT_NOT_FOUND',
        llm_chosen_sku: pick.chosen_sku,
        llm_chosen_variant_id: pick.chosen_variant_id,
      })
      return {
        product: undefined,
        overridden: true,
        overrideReason: 'VARIANT_NOT_FOUND',
        llmReason: pick.reason,
      }
    }
    return {
      product: chosen,
      overridden: false,
      llmReason: pick.reason,
      variantId: variant.variant_id,
      variantLabel: variant.label,
    }
  }

  return { product: chosen, overridden: false, llmReason: pick.reason }
}

function override(
  reason: GuardrailOverrideReason,
  candidates: Product[],
  goal: ChooseProductGoal,
  log: LogStep,
  pick?: LlmPick,
): ResolvedChoice {
  log('guardrail_override', { reason, llm_chosen_sku: pick?.chosen_sku ?? null })
  const product = fallbackPick(candidates, goal.ceiling_paise)
  return pick?.reason === undefined
    ? { product, overridden: true, overrideReason: reason }
    : { product, overridden: true, overrideReason: reason, llmReason: pick.reason }
}

function toOutcome(settlement: SettlementResult, product: Product): PurchaseOutcome {
  if (settlement.state === 'captured') return { status: 'completed', product, settlement }
  if (settlement.state === 'pending_approval') {
    return { status: 'pending_approval', product, settlement }
  }
  return { status: 'blocked', reason: settlement.reason ?? settlement.state, product, settlement }
}
