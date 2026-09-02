/**
 * The mandate-chain verification gate. This is the only place authorization
 * decisions get made — every check is deterministic given `ctx`, and checks
 * run in a fixed order so the first failure reported is always the most
 * fundamental one (a forged signature is reported before a stale price,
 * even if both are true).
 *
 * Schema validation runs first and stays structural only (shapes, non-empty
 * strings, integer-ness) precisely because `intent`/`cart` are typed as
 * trusted `IntentMandate`/`CartMandate` at the TS boundary but may in
 * practice have been produced by `JSON.parse` + an unchecked cast at an HTTP
 * boundary upstream — the runtime shape is not guaranteed by the type.
 */

import { canonicalJson } from './canonical-json.js'
import { sha256Hex } from './hash.js'
import type { CartItem, CartMandate, IntentMandate, SigEnvelope } from './mandate.js'
import { cartSigningBytes, intentSigningBytes } from './mandate.js'
import type { Credential } from './signature.js'
import { verifyMandateSignature } from './signature.js'

export type RejectionCode =
  | 'SCHEMA_INVALID'
  | 'MANDATE_UNKNOWN'
  | 'SIG_INVALID_INTENT'
  | 'HASH_LINK_MISMATCH'
  | 'SIG_INVALID_CART'
  | 'LINE_ITEM_INVALID'
  | 'PRICE_MISMATCH'
  | 'CURRENCY_MISMATCH'
  | 'MERCHANT_NOT_IN_SCOPE'
  | 'MANDATE_EXPIRED'
  | 'MANDATE_REVOKED'
  | 'AMOUNT_EXCEEDS_CEILING'
  | 'MERCHANT_LIMIT_EXCEEDED'
  // Not produced by verifyChain. Emitted by the facilitator's settlement service
  // when the one_live_settlement_per_mandate index rejects a second concurrent
  // live settlement — i.e. a purchase is already in flight for this mandate. Kept
  // in this shared code because that route reports it, not because a mandate
  // carries a reserved/consumed allowance state (the cumulative wallet has none).
  | 'ALLOWANCE_RESERVED'
  | 'DUPLICATE_CART'

export type VerifyCtx = {
  now: number
  /**
   * The mandate's registered credential — the HUMAN key bound at ceremony time.
   * It verifies the intent signature (and, at the route layer, approvals and
   * revocations). It is a distinct party from the agent key the intent carries
   * in `agent_pubkey_hex`; the agent never holds this credential, which is what
   * makes the human-in-the-loop gate a real second factor. Absent means no
   * credential is registered for this mandate.
   */
  credential?: Credential
  revoked: boolean
  /**
   * Total already-captured spend under this mandate, in paise. The ceiling is a
   * cumulative wallet, so a cart is rejected AMOUNT_EXCEEDS_CEILING when
   * `spentPaise + cart.total_paise` exceeds `ceiling_paise`, not when the single
   * cart does. Defaults to 0 (a mandate with no prior captures), which reduces to
   * the original per-cart check for the first purchase.
   */
  spentPaise?: number
  /**
   * Total already-captured spend under this mandate AT the cart's merchant, in
   * paise. Only consulted when the intent carries a `per_merchant_ceiling_paise`
   * entry for that merchant; defaults to 0. Like `spentPaise`, the current
   * settlement is non-terminal and never counts toward its own limit.
   */
  merchantSpentPaise?: number
  catalogPrices?: Record<string, number>
  duplicateCart: boolean
  /** Unix-seconds grace window applied to `expires_at`. Default 60. */
  clockSkewSec?: number
}

export type VerifyResult =
  | { ok: true; needsApproval: boolean; mandateCartHashHex: string }
  | { ok: false; reason: RejectionCode; detail?: string }

function fail(reason: RejectionCode, detail?: string): VerifyResult {
  return detail === undefined ? { ok: false, reason } : { ok: false, reason, detail }
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0
}

function isSafeInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v)
}

function isValidSigEnvelope(v: unknown): v is SigEnvelope {
  if (typeof v !== 'object' || v === null) return false
  const sig = v as Record<string, unknown>
  if (sig.type === 'ed25519') return isNonEmptyString(sig.signature_hex)
  if (sig.type === 'webauthn-es256') {
    return (
      isNonEmptyString(sig.clientDataJSON_b64u) &&
      isNonEmptyString(sig.authenticatorData_b64u) &&
      isNonEmptyString(sig.signature_b64u)
    )
  }
  return false
}

function validateIntentSchema(intent: IntentMandate): string | undefined {
  if (!isNonEmptyString(intent.mandateId)) return 'mandateId must be a non-empty string'
  if (!isNonEmptyString(intent.goal)) return 'goal must be a non-empty string'
  if (!isSafeInt(intent.ceiling_paise) || intent.ceiling_paise <= 0) {
    return 'ceiling_paise must be a positive integer'
  }
  if (!isSafeInt(intent.approval_threshold_paise) || intent.approval_threshold_paise < 0) {
    return 'approval_threshold_paise must be a non-negative integer'
  }
  if (!Array.isArray(intent.merchants) || intent.merchants.length === 0) {
    return 'merchants must be a non-empty array'
  }
  if (!intent.merchants.every(isNonEmptyString)) return 'merchants must all be non-empty strings'
  if (!isSafeInt(intent.expires_at)) return 'expires_at must be an integer unix timestamp'
  if (!isNonEmptyString(intent.agent_pubkey_hex))
    return 'agent_pubkey_hex must be a non-empty string'
  // Optional spending-policy fields — well-typed if present at all. A malformed
  // policy is a structural rejection, not silently ignored, since it's signed
  // authority the human granted and the agent could otherwise dodge by garbling.
  if (intent.per_merchant_ceiling_paise !== undefined) {
    const limits = intent.per_merchant_ceiling_paise
    if (typeof limits !== 'object' || limits === null || Array.isArray(limits)) {
      return 'per_merchant_ceiling_paise must be an object of merchant -> paise'
    }
    for (const [merchant, limit] of Object.entries(limits)) {
      if (!isNonEmptyString(merchant)) return 'per_merchant_ceiling_paise keys must be merchant ids'
      if (!isSafeInt(limit) || limit < 0) {
        return `per_merchant_ceiling_paise[${merchant}] must be a non-negative integer`
      }
    }
  }
  if (
    intent.cumulative_approval_threshold_paise !== undefined &&
    (!isSafeInt(intent.cumulative_approval_threshold_paise) ||
      intent.cumulative_approval_threshold_paise < 0)
  ) {
    return 'cumulative_approval_threshold_paise must be a non-negative integer'
  }
  if (!isValidSigEnvelope(intent.sig)) return 'sig is not a valid signature envelope'
  return undefined
}

function validateCartItemSchema(item: CartItem, index: number): string | undefined {
  if (!isNonEmptyString(item.sku)) return `items[${index}].sku must be a non-empty string`
  if (!isSafeInt(item.qty) || item.qty < 1) return `items[${index}].qty must be an integer >= 1`
  if (!isSafeInt(item.unit_price_paise) || item.unit_price_paise <= 0) {
    return `items[${index}].unit_price_paise must be a positive integer`
  }
  // Both fields are optional (see CartItem's doc comments), but if present at all
  // they must be well-typed — an empty-string variant_id is indistinguishable from
  // "no variant" downstream, so it's rejected rather than silently treated as unset.
  if (item.variant_id !== undefined && !isNonEmptyString(item.variant_id)) {
    return `items[${index}].variant_id must be a non-empty string when present`
  }
  if (item.variant_label !== undefined && typeof item.variant_label !== 'string') {
    return `items[${index}].variant_label must be a string when present`
  }
  return undefined
}

function validateCartSchema(cart: CartMandate): string | undefined {
  if (!isNonEmptyString(cart.cartId)) return 'cartId must be a non-empty string'
  if (!isNonEmptyString(cart.merchant_id)) return 'merchant_id must be a non-empty string'
  if (!Array.isArray(cart.items) || cart.items.length === 0)
    return 'items must be a non-empty array'
  for (let i = 0; i < cart.items.length; i++) {
    const err = validateCartItemSchema(cart.items[i] as CartItem, i)
    if (err) return err
  }
  if (!isSafeInt(cart.total_paise) || cart.total_paise < 0) {
    return 'total_paise must be a non-negative integer'
  }
  if (!isNonEmptyString(cart.intent_hash_hex)) return 'intent_hash_hex must be a non-empty string'
  if (!isNonEmptyString(cart.agent_sig_hex)) return 'agent_sig_hex must be a non-empty string'
  return undefined
}

/** Runs the full mandate-chain gate. Checks execute in a fixed order — see `RejectionCode`. */
export function verifyChain(
  intent: IntentMandate,
  cart: CartMandate,
  ctx: VerifyCtx,
): VerifyResult {
  const intentSchemaErr = validateIntentSchema(intent)
  if (intentSchemaErr) return fail('SCHEMA_INVALID', intentSchemaErr)
  const cartSchemaErr = validateCartSchema(cart)
  if (cartSchemaErr) return fail('SCHEMA_INVALID', cartSchemaErr)

  const credential = ctx.credential
  if (!credential) return fail('MANDATE_UNKNOWN', 'no credential registered for this agent key')

  const intentBytes = intentSigningBytes(intent)
  if (!verifyMandateSignature(intentBytes, intent.sig, credential)) {
    return fail('SIG_INVALID_INTENT')
  }

  const intentHashHex = sha256Hex(intentBytes)
  if (cart.intent_hash_hex !== intentHashHex) return fail('HASH_LINK_MISMATCH')

  // The cart is verified against the AGENT key the intent declares, not the
  // registered (human) credential. Those are two distinct parties: the human
  // signs the intent (verified above), and the intent — being human-signed —
  // attests the agent key, so the agent key is trustworthy precisely because
  // the human vouched for it. The agent holds only this key; it can build and
  // sign carts but cannot produce an approval or revocation, which require the
  // human credential at the route layer.
  const cartBytes = cartSigningBytes(cart)
  const cartSig: SigEnvelope = { type: 'ed25519', signature_hex: cart.agent_sig_hex }
  const agentCredential: Credential = { type: 'ed25519', publicKey_hex: intent.agent_pubkey_hex }
  if (!verifyMandateSignature(cartBytes, cartSig, agentCredential)) return fail('SIG_INVALID_CART')

  const recomputedTotal = cart.items.reduce(
    (sum, item) => sum + item.qty * item.unit_price_paise,
    0,
  )
  if (recomputedTotal !== cart.total_paise) {
    return fail('LINE_ITEM_INVALID', 'total_paise does not match sum(qty * unit_price_paise)')
  }

  if (ctx.catalogPrices) {
    for (const item of cart.items) {
      const catalogPrice = ctx.catalogPrices[item.sku]
      if (catalogPrice === undefined || catalogPrice !== item.unit_price_paise) {
        return fail('PRICE_MISMATCH', `sku ${item.sku} price does not match catalog`)
      }
    }
  }

  if (intent.currency !== 'INR') return fail('CURRENCY_MISMATCH')

  if (!intent.merchants.includes(cart.merchant_id)) return fail('MERCHANT_NOT_IN_SCOPE')

  const skew = ctx.clockSkewSec ?? 60
  if (ctx.now > intent.expires_at + skew) return fail('MANDATE_EXPIRED')

  if (ctx.revoked) return fail('MANDATE_REVOKED')

  // Budget comes after mandate-liveness (expiry/revocation) and scope: those say
  // the mandate is dead or the cart is out of scope, which is more fundamental
  // than "this would exceed budget" — a revoked mandate must report REVOKED, not
  // a budget error, even when it's also over budget. Cumulative wallet: the
  // ceiling caps total captured spend, so this cart is measured against what's
  // already been spent, not in isolation. spentPaise defaults to 0 (no prior
  // captures), collapsing to a plain per-cart check for the first purchase.
  const spentPaise = ctx.spentPaise ?? 0
  if (spentPaise + cart.total_paise > intent.ceiling_paise) {
    return fail(
      'AMOUNT_EXCEEDS_CEILING',
      `cart ${cart.total_paise} + already-spent ${spentPaise} exceeds ceiling ${intent.ceiling_paise}`,
    )
  }

  // Per-merchant sub-ceiling, when the human set one for this cart's merchant.
  const merchantLimit = intent.per_merchant_ceiling_paise?.[cart.merchant_id]
  if (merchantLimit !== undefined) {
    const merchantSpent = ctx.merchantSpentPaise ?? 0
    if (merchantSpent + cart.total_paise > merchantLimit) {
      return fail(
        'MERCHANT_LIMIT_EXCEEDED',
        `cart ${cart.total_paise} + already-spent-at-merchant ${merchantSpent} exceeds the ${cart.merchant_id} limit ${merchantLimit}`,
      )
    }
  }

  if (ctx.duplicateCart) return fail('DUPLICATE_CART')

  const cartHashHex = sha256Hex(cartBytes)
  const mandateCartHashHex = sha256Hex(
    canonicalJson({ intent_hash: intentHashHex, cart_hash: cartHashHex }),
  )

  // Approval fires on the per-cart threshold OR, when the human set a cumulative
  // line, once total spend would cross it. The cumulative arm closes the
  // cart-splitting gap: without it, many carts each under the per-cart threshold
  // drain the whole ceiling with no human check.
  const crossesCumulative =
    intent.cumulative_approval_threshold_paise !== undefined &&
    spentPaise + cart.total_paise > intent.cumulative_approval_threshold_paise
  return {
    ok: true,
    needsApproval: cart.total_paise > intent.approval_threshold_paise || crossesCumulative,
    mandateCartHashHex,
  }
}
