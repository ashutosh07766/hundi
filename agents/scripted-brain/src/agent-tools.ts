/**
 * BuyerTools — the swap-the-brain contract. Every buyer brain (this deterministic
 * one, a future LLM-driven one) is built entirely on top of these methods and
 * nothing else. `requestPayment` is the only money-adjacent capability: it signs a
 * CartMandate with the agent's own key, hands it to the facilitator's /settlements
 * endpoint, and polls for the outcome. There is no settle/capture/refund method on
 * this interface, and this file imports no payment-provider SDK — a brain built on
 * BuyerTools can ask the facilitator to attempt a payment but can never touch a
 * payment provider directly. That is a structural guarantee (the capability does
 * not exist on the type), not a policy one a brain implementation could bypass.
 *
 * `recordDecision` is the one non-core method: pure ledger narration (a human
 * reviewing a pending_approval settlement reads it), never touches settlement state
 * or money, and is optional — a brain that never implements it still satisfies the
 * full contract.
 */

import { randomUUID } from 'node:crypto'
import type { CanonicalValue, CartItem, CartMandate, IntentMandate } from '@hundi/core'
import { canonicalJson, cartSigningBytes, intentSigningBytes, sha256Hex } from '@hundi/core'
import type { AgentKeypair } from './ed25519.js'
import { signPayload } from './ed25519.js'

export type Availability = { status: 'in_stock' | 'out_of_stock' }

/** One purchasable SKU within a product (e.g. a specific size/color) — mirrors
 * `ScannedVariant` in @hundi/cli's scanner.ts and `FeedProduct.variants` in
 * packages/facilitator's feed-product.ts. This package doesn't depend on
 * @hundi/cli, so the shape is duplicated rather than imported, same as `Product`
 * itself already is relative to `FeedProduct`. */
export type ProductVariant = {
  variant_id: string
  label: string
  option_values: string[]
  price_paise: number
  available: boolean
}

export type ProductOption = { name: string; values: string[] }

/** The shape the store's /api/catalog and /api/products/:id feeds emit — see
 * apps/store/src/app.ts's toFeedProduct. */
export type Product = {
  id: string
  title: string
  description: string
  price_paise: number
  currency: string
  availability: Availability
  image: string
  brand: string
  merchant_id: string
  /** Present only on a compromised catalog listing (see apps/store/src/poison-fixture.ts) —
   * the attacker-controlled merchant/price its description tries to inject. Absent on every
   * genuine listing; a normal brain has no reason to ever read this field, since `merchant_id`
   * and `price_paise` above are always the store's own real values regardless. */
  injectedPayload?: { merchant_id: string; price_paise: number }
  /** Every purchasable variant, present only for a multi-variant listing. Absent
   * for a single-SKU product. */
  variants?: ProductVariant[]
  options?: ProductOption[]
}

export type CartDraft = {
  merchant_id: string
  items: CartItem[]
  total_paise: number
}

export type SettlementState =
  | 'created'
  | 'verifying'
  | 'verified'
  | 'pending_approval'
  | 'approved'
  | 'settling'
  | 'captured'
  | 'failed'
  | 'rejected'
  | 'abandoned'

export type SettlementResult = {
  settlement_id: string
  state: SettlementState
  reason?: string
}

function settlementResult(
  settlement_id: string,
  state: SettlementState,
  reason?: string,
): SettlementResult {
  return reason === undefined ? { settlement_id, state } : { settlement_id, state, reason }
}

/** States requestPayment stops polling at — either a terminal outcome or a state
 * that now requires a human decision. requestPayment never blocks waiting for a
 * human to click approve; it reports pending_approval and returns. */
const POLL_STOP_STATES: ReadonlySet<SettlementState> = new Set([
  'pending_approval',
  'captured',
  'failed',
  'rejected',
  'abandoned',
])

export type CartLineInput = {
  product: Product
  qty: number
  /** Selects a specific variant (size/color) off `product.variants`. The line's
   * signed price comes from the variant's own `price_paise`, not the product's —
   * see `buildCartDraft`. Omit to buy the product with no variant recorded, the
   * same as before variants existed. */
  variantId?: string
}

export interface BuyerTools {
  searchCatalog(query?: string): Promise<Product[]>
  getProduct(id: string): Promise<Product>
  proposeCart(items: ReadonlyArray<CartLineInput>): CartDraft
  requestPayment(args: {
    intent: IntentMandate
    cart: CartDraft
    agent: AgentKeypair
  }): Promise<SettlementResult>
  /** Appends the brain's own stated rationale to a settlement's ledger trail, signed
   * by the agent's key. Never touches money or settlement state. */
  recordDecision?(args: {
    settlementId: string
    payload: Record<string, CanonicalValue>
    agent: AgentKeypair
  }): Promise<void>
}

/** Pure — no I/O. Sums line items from already-fetched Product data; every buyer
 * brain builds its cart through this so price/total math lives in exactly one
 * place, taken from the catalog response, never invented client-side. When a
 * line carries `variantId`, the unit price and `variant_label` come from that
 * variant's own catalog data (never the product's flat `price_paise`) — this is
 * what makes a selected variant's price authoritative rather than assumed. */
export function buildCartDraft(items: ReadonlyArray<CartLineInput>): CartDraft {
  const first = items[0]
  if (!first) throw new Error('buildCartDraft: at least one item is required')
  const merchantId = first.product.merchant_id

  const cartItems: CartItem[] = items.map(({ product, qty, variantId }) => {
    if (product.merchant_id !== merchantId) {
      throw new Error('buildCartDraft: all items must share one merchant_id')
    }
    if (!variantId) return { sku: product.id, qty, unit_price_paise: product.price_paise }

    const variant = product.variants?.find((v) => v.variant_id === variantId)
    if (!variant) {
      throw new Error(`buildCartDraft: variant "${variantId}" not found on product "${product.id}"`)
    }
    return {
      sku: product.id,
      qty,
      unit_price_paise: variant.price_paise,
      variant_id: variant.variant_id,
      variant_label: variant.label,
    }
  })
  const total_paise = cartItems.reduce((sum, item) => sum + item.qty * item.unit_price_paise, 0)
  return { merchant_id: merchantId, items: cartItems, total_paise }
}

function signCart(draft: CartDraft, intent: IntentMandate, agent: AgentKeypair): CartMandate {
  const unsigned: Omit<CartMandate, 'agent_sig_hex'> = {
    cartId: randomUUID(),
    merchant_id: draft.merchant_id,
    items: draft.items,
    total_paise: draft.total_paise,
    intent_hash_hex: sha256Hex(intentSigningBytes(intent)),
  }
  const sig = signPayload(agent.privateKey, cartSigningBytes(unsigned))
  return { ...unsigned, agent_sig_hex: sig.signature_hex }
}

/** Records the agent's own stated rationale against a settlement. Deliberately not
 * folded into BuyerTools' required surface: it is audit narration, not a capability
 * a brain needs in order to complete a purchase. */
export async function postDecisionRationale(
  facilitatorUrl: string,
  settlementId: string,
  payload: Record<string, CanonicalValue>,
  agent: AgentKeypair,
): Promise<void> {
  const signature_hex = signPayload(agent.privateKey, canonicalJson(payload)).signature_hex
  const base = facilitatorUrl.replace(/\/$/, '')
  const res = await fetch(`${base}/settlements/${settlementId}/decisions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ payload, signature_hex }),
  })
  if (!res.ok) throw new Error(`postDecisionRationale: facilitator returned ${res.status}`)
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init)
  if (!res.ok) throw new Error(`request to ${url} failed with ${res.status}`)
  return (await res.json()) as T
}

export type HttpBuyerToolsOptions = {
  storeUrl: string
  facilitatorUrl: string
  /** Points searchCatalog at the store's poisoned demo feed instead of the clean
   * one. Exists only so a compromised-catalog scenario can be simulated at the HTTP
   * boundary — this file never inspects, trusts, or acts on product description
   * text, poisoned or not; it only ever reads structured fields (id/title/
   * price_paise/availability/merchant_id). */
  poisonedCatalog?: boolean
  pollIntervalMs?: number
  pollTimeoutMs?: number
}

type SettlementCreateBody =
  | { ok: true; settlement_id: string; state: SettlementState; reason?: string }
  | { ok: false; error: string; reason?: string }

type SettlementGetBody = {
  ok: boolean
  settlement?: { state: SettlementState; reject_reason: string | null }
}

/** The one implementation of BuyerTools this package ships: real HTTP calls to a
 * store base URL and a facilitator base URL. No other network target is ever
 * reachable from this class — grep its body for every `fetch(` call. */
export class HttpBuyerTools implements BuyerTools {
  private readonly storeUrl: string
  private readonly facilitatorUrl: string
  private readonly poisonedCatalog: boolean
  private readonly pollIntervalMs: number
  private readonly pollTimeoutMs: number

  constructor(opts: HttpBuyerToolsOptions) {
    this.storeUrl = opts.storeUrl.replace(/\/$/, '')
    this.facilitatorUrl = opts.facilitatorUrl.replace(/\/$/, '')
    this.poisonedCatalog = opts.poisonedCatalog ?? false
    this.pollIntervalMs = opts.pollIntervalMs ?? 10
    this.pollTimeoutMs = opts.pollTimeoutMs ?? 2000
  }

  async searchCatalog(query?: string): Promise<Product[]> {
    const qs = this.poisonedCatalog ? '?poisoned=1' : ''
    const products = await fetchJson<Product[]>(`${this.storeUrl}/api/catalog${qs}`)
    if (!query) return products
    const needle = query.toLowerCase()
    return products.filter(
      (p) => p.title.toLowerCase().includes(needle) || p.description.toLowerCase().includes(needle),
    )
  }

  async getProduct(id: string): Promise<Product> {
    return fetchJson<Product>(`${this.storeUrl}/api/products/${encodeURIComponent(id)}`)
  }

  proposeCart(items: ReadonlyArray<{ product: Product; qty: number }>): CartDraft {
    return buildCartDraft(items)
  }

  async requestPayment(args: {
    intent: IntentMandate
    cart: CartDraft
    agent: AgentKeypair
  }): Promise<SettlementResult> {
    const cart = signCart(args.cart, args.intent, args.agent)

    const res = await fetch(`${this.facilitatorUrl}/settlements`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() },
      body: JSON.stringify({ intent: args.intent, cart }),
    })
    const body = (await res.json()) as SettlementCreateBody

    if (!body.ok) return settlementResult('', 'rejected', body.error)
    if (POLL_STOP_STATES.has(body.state))
      return settlementResult(body.settlement_id, body.state, body.reason)
    return this.pollSettlement(body.settlement_id)
  }

  async recordDecision(args: {
    settlementId: string
    payload: Record<string, CanonicalValue>
    agent: AgentKeypair
  }): Promise<void> {
    await postDecisionRationale(this.facilitatorUrl, args.settlementId, args.payload, args.agent)
  }

  private async pollSettlement(settlementId: string): Promise<SettlementResult> {
    const deadline = Date.now() + this.pollTimeoutMs
    let lastState: SettlementState = 'created'
    let lastReason: string | undefined

    while (Date.now() < deadline) {
      const res = await fetch(`${this.facilitatorUrl}/settlements/${settlementId}`)
      const body = (await res.json()) as SettlementGetBody
      if (body.ok && body.settlement) {
        lastState = body.settlement.state
        lastReason = body.settlement.reject_reason ?? undefined
        if (POLL_STOP_STATES.has(lastState)) {
          return settlementResult(settlementId, lastState, lastReason)
        }
      }
      await sleep(this.pollIntervalMs)
    }
    return settlementResult(settlementId, lastState, lastReason ?? 'POLL_TIMEOUT')
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
