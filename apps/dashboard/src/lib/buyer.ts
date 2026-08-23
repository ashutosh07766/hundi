/**
 * Client-side buyer logic for the "Run test purchase" / "Run scam test"
 * buttons. Mirrors agents/scripted-brain/src/agent-tools.ts's HttpBuyerTools
 * (catalog fetch, cart signing, settlement submit/poll) and
 * scripted-brain.ts's cheapest-in-stock-under-ceiling selection policy —
 * this is that same buyer logic, running in the tab that holds the agent's
 * private key (see agent-key.ts) instead of a separate agent process.
 *
 * This is a DEMO convenience that runs the agent's buyer logic client-side so
 * a non-technical operator can trigger a real purchase attempt with one
 * click; in production the agent is a separate process holding its own key.
 * The security boundary is identical either way: the facilitator
 * (packages/facilitator's settlement-service.ts -> @hundi/core's
 * verifyChain) verifies every cart against the signed intent mandate
 * regardless of which process built and signed it — this module has no
 * elevated trust and could be deleted without changing what the facilitator
 * accepts.
 */

import type { CartItem, CartMandate, IntentMandate } from '@hundi/core'
import { cartSigningBytes, intentSigningBytes, sha256Hex } from '@hundi/core'
import { formatPaise } from './format.js'
import type { HumanKeypair } from './signing.js'
import { signBytes } from './signing.js'

/** Same {secretKeyHex, publicKeyHex} shape and ed25519 signing math as the
 * human key (signing.ts) — the agent key is just another ed25519 identity. */
export type AgentKeyPair = HumanKeypair

export type StoreAvailability = { status: 'in_stock' | 'out_of_stock' }

/** The shape apps/store/src/app.ts's toFeedProduct emits at GET /api/catalog. */
export type StoreProduct = {
  id: string
  title: string
  price_paise: number
  availability: StoreAvailability
  merchant_id: string
  /** Present only on the poisoned-feed demo listing (apps/store/src/
   * poison-fixture.ts). A normal listing never carries this field. */
  injectedPayload?: { merchant_id: string; price_paise: number }
}

export type PickResult =
  | { ok: true; product: StoreProduct; merchantId: string; unitPricePaise: number }
  | { ok: false; reason: 'NO_CANDIDATE' | 'NO_POISONED_PRODUCT' }

/** Pure — no I/O.
 *
 * Normal mode: cheapest in-stock listing at or under the mandate's ceiling,
 * the same rule agents/scripted-brain/src/scripted-brain.ts's runPurchase
 * applies.
 *
 * Poisoned mode: the listing carrying the injected attacker payload, with
 * the cart pointed at ITS merchant/price rather than the listing's own real
 * fields — reproduces a buyer brain that treated embedded description text
 * as instructions. Nothing here decides whether that cart is allowed; the
 * facilitator's merchant-allowlist check is what has to catch it. */
export function pickProduct(
  products: readonly StoreProduct[],
  intent: Pick<IntentMandate, 'ceiling_paise'>,
  poisoned: boolean,
): PickResult {
  if (poisoned) {
    const target = products.find((p) => p.injectedPayload !== undefined)
    if (!target?.injectedPayload) return { ok: false, reason: 'NO_POISONED_PRODUCT' }
    return {
      ok: true,
      product: target,
      merchantId: target.injectedPayload.merchant_id,
      unitPricePaise: target.injectedPayload.price_paise,
    }
  }
  const affordable = products
    .filter((p) => p.availability.status === 'in_stock' && p.price_paise <= intent.ceiling_paise)
    .sort((a, b) => a.price_paise - b.price_paise)
  const product = affordable[0]
  if (!product) return { ok: false, reason: 'NO_CANDIDATE' }
  return { ok: true, product, merchantId: product.merchant_id, unitPricePaise: product.price_paise }
}

export type UnsignedCart = Omit<CartMandate, 'agent_sig_hex'>

/** Pure — everything cartSigningBytes signs over, chained to `intent` by hash. */
export function buildUnsignedCart(
  pick: Extract<PickResult, { ok: true }>,
  intent: IntentMandate,
): UnsignedCart {
  const items: CartItem[] = [
    { sku: pick.product.id, qty: 1, unit_price_paise: pick.unitPricePaise },
  ]
  return {
    cartId: crypto.randomUUID(),
    merchant_id: pick.merchantId,
    items,
    total_paise: pick.unitPricePaise,
    intent_hash_hex: sha256Hex(intentSigningBytes(intent)),
  }
}

/** Signs `unsigned` with the AGENT key — mirrors core's verifyEd25519 exactly
 * (signBytes is the same math signing.ts uses for the human key), so the
 * resulting envelope verifies against `intent.agent_pubkey_hex` at the
 * facilitator's verifyChain. */
export function signCart(unsigned: UnsignedCart, agentKeyPair: AgentKeyPair): CartMandate {
  const sig = signBytes(agentKeyPair.secretKeyHex, cartSigningBytes(unsigned))
  return { ...unsigned, agent_sig_hex: sig.signature_hex }
}

async function fetchCatalog(storeUrl: string, poisoned: boolean): Promise<StoreProduct[]> {
  const qs = poisoned ? '?poisoned=1' : ''
  const res = await fetch(`${storeUrl.replace(/\/$/, '')}/api/catalog${qs}`)
  if (!res.ok) throw new Error(`store catalog fetch failed with status ${res.status}`)
  return (await res.json()) as StoreProduct[]
}

type SettlementCreateBody =
  | { ok: true; settlement_id: string; state: string; reason?: string }
  | { ok: false; error: string; reason?: string }

type SettlementGetBody = {
  ok: boolean
  settlement?: { state: string; reject_reason: string | null }
}

/** States requestPayment/polling stops at — either a terminal outcome or a
 * state that now requires a human decision. Mirrors agent-tools.ts's
 * POLL_STOP_STATES exactly; the two must stay in sync since they both
 * describe the same SettlementState machine (packages/facilitator's
 * state-machine.ts). */
const POLL_STOP_STATES = new Set([
  'pending_approval',
  'captured',
  'failed',
  'rejected',
  'abandoned',
])

type SettlementOutcome = { settlementId: string; state: string; reason?: string }

function settlementOutcome(
  settlementId: string,
  state: string,
  reason?: string,
): SettlementOutcome {
  return reason === undefined ? { settlementId, state } : { settlementId, state, reason }
}

async function submitSettlement(
  facilitatorUrl: string,
  intent: IntentMandate,
  cart: CartMandate,
): Promise<SettlementOutcome> {
  const res = await fetch(`${facilitatorUrl.replace(/\/$/, '')}/settlements`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
    body: JSON.stringify({ intent, cart }),
  })
  let body: SettlementCreateBody
  try {
    body = (await res.json()) as SettlementCreateBody
  } catch {
    throw new Error(`facilitator returned a non-JSON response (status ${res.status})`)
  }
  // A rejected/blocked settlement is `{ ok: true, state: 'rejected', reason }` —
  // verifyChain failures are a normal outcome, not a request error. `ok: false`
  // here means the request itself was malformed/conflicted (see settlements.ts).
  if (!body.ok) return settlementOutcome('', 'rejected', body.error)
  return settlementOutcome(body.settlement_id, body.state, body.reason)
}

type PollOutcome = { state: string; reason?: string }

function pollOutcome(state: string, reason?: string): PollOutcome {
  return reason === undefined ? { state } : { state, reason }
}

async function pollSettlement(
  facilitatorUrl: string,
  settlementId: string,
  { intervalMs = 2000, timeoutMs = 10_000 } = {},
): Promise<PollOutcome> {
  const deadline = Date.now() + timeoutMs
  let lastState = 'created'
  let lastReason: string | undefined
  while (Date.now() < deadline) {
    await sleep(intervalMs)
    const res = await fetch(`${facilitatorUrl.replace(/\/$/, '')}/settlements/${settlementId}`)
    const body = (await res.json()) as SettlementGetBody
    if (body.ok && body.settlement) {
      lastState = body.settlement.state
      lastReason = body.settlement.reject_reason ?? undefined
      if (POLL_STOP_STATES.has(lastState)) return pollOutcome(lastState, lastReason)
    }
  }
  return pollOutcome(lastState, lastReason ?? 'POLL_TIMEOUT')
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export type TestPurchaseResult = {
  ok: boolean
  state: string
  reason?: string
  chosen?: { title: string; price_paise: number }
  paymentId?: string
}

/** Runs one end-to-end test-purchase attempt: fetch the store's catalog, pick a
 * product (see `pickProduct`), sign a cart with the agent key, submit it to the
 * facilitator, and poll to a terminal/pending state. Every network call is
 * scoped to `storeUrl`/`facilitatorUrl` — no other endpoint is ever reached.
 * `onStep` is optional narration for an inline status line; the function's
 * behavior is identical whether or not a caller passes one. */
export async function runTestPurchase(args: {
  mandateId: string
  intent: IntentMandate
  agentKeyPair: AgentKeyPair
  storeUrl: string
  facilitatorUrl: string
  poisoned: boolean
  onStep?: (message: string) => void
}): Promise<TestPurchaseResult> {
  const step = args.onStep ?? (() => {})
  step('shopping…')
  const products = await fetchCatalog(args.storeUrl, args.poisoned)
  const pick = pickProduct(products, args.intent, args.poisoned)
  if (!pick.ok) return { ok: false, state: 'blocked', reason: pick.reason }
  step(`picked ${pick.product.title} at ${formatPaise(pick.unitPricePaise)}`)

  const unsigned = buildUnsignedCart(pick, args.intent)
  const cart = signCart(unsigned, args.agentKeyPair)

  step('submitting…')
  const created = await submitSettlement(args.facilitatorUrl, args.intent, cart)
  const final: PollOutcome =
    created.settlementId && !POLL_STOP_STATES.has(created.state)
      ? await pollSettlement(args.facilitatorUrl, created.settlementId)
      : created

  const chosen = { title: pick.product.title, price_paise: pick.unitPricePaise }
  const ok = final.state === 'captured' || final.state === 'pending_approval'
  const paymentId = created.settlementId || undefined
  const base = { ok, state: final.state, chosen }
  return {
    ...base,
    ...(final.reason === undefined ? {} : { reason: final.reason }),
    ...(paymentId === undefined ? {} : { paymentId }),
  }
}
