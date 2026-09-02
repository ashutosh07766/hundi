/**
 * Mandate chain shapes and their signing payloads. No zod here — core stays
 * dependency-minimal (crypto only) so it can run in any JS runtime. Callers
 * that need schema validation from untrusted input (HTTP bodies, etc.)
 * should validate with a schema layer of their own before constructing
 * these types; `verify.ts`'s SCHEMA_INVALID check re-validates structurally
 * regardless, since a mandate chain must never be trusted just because it
 * type-checked at the boundary.
 */

import { canonicalJson } from './canonical-json.js'

export type SigEnvelope =
  | { type: 'ed25519'; signature_hex: string }
  | {
      type: 'webauthn-es256'
      clientDataJSON_b64u: string
      authenticatorData_b64u: string
      signature_b64u: string
    }

/** Ceiling authority a human grants an agent for a stated goal. Signed by the
 * HUMAN key (the registered credential); the agent key it authorizes to sign
 * carts is carried in `agent_pubkey_hex`. Two distinct keys — the agent can
 * spend within the envelope but can never approve or revoke. */
export type IntentMandate = {
  mandateId: string
  goal: string
  ceiling_paise: number
  approval_threshold_paise: number
  currency: 'INR'
  merchants: string[]
  /** Unix seconds. */
  expires_at: number
  agent_pubkey_hex: string
  /** Optional per-merchant sub-ceilings (paise). When a merchant appears here, the
   * agent's cumulative captured spend AT THAT MERCHANT may not exceed this, on top
   * of (and never above) the global `ceiling_paise`. A merchant not listed is
   * bounded only by the global ceiling. Signed — the human authorizes the split.
   * Absent entirely (never `null`) leaves the signing bytes byte-identical to the
   * pre-policy shape; `| undefined` lets a Zod-validated intent feed this type
   * under exactOptionalPropertyTypes. */
  per_merchant_ceiling_paise?: Record<string, number> | undefined
  /** Optional cumulative approval line (paise). When set, a purchase needs human
   * approval once total captured spend WOULD cross this line — closing the gap the
   * per-cart `approval_threshold_paise` leaves open, where many sub-threshold carts
   * drain the whole ceiling hands-free. Absent → only the per-cart threshold
   * applies, byte-identical to the pre-policy shape. */
  cumulative_approval_threshold_paise?: number | undefined
  /** Optional purpose restriction (signed). When set, every cart item must match at
   * least one keyword (case-insensitive substring) against the product text the
   * facilitator resolves for it — a "running shoes" mandate can't quietly buy a
   * blender. A cart item whose product text can't be resolved fails closed rather
   * than passing unchecked, since the human explicitly scoped what this money is
   * for. Absent entirely (never `null`) leaves the signing bytes byte-identical to
   * the pre-goal-binding shape, same convention as the other optional policy fields
   * above. */
  goal_keywords?: string[] | undefined
  sig: SigEnvelope
}

export type CartItem = {
  sku: string
  qty: number
  unit_price_paise: number
  /** The specific variant (size/color) this line item buys, when the product has
   * more than one. Included in `cartSigningBytes` — the agent's signature must
   * cover the exact variant, or a variant swapped in after signing would still
   * verify. Absent entirely (never `null`) when no variant was chosen, so a
   * cart's signed bytes are byte-identical to the pre-variant shape. The explicit
   * `| undefined` lets the facilitator's Zod ingest schema (which infers optional
   * fields as `T | undefined`) feed a validated cart straight into this type under
   * `exactOptionalPropertyTypes` — an absent key and an explicit `undefined` are
   * both treated as "no variant" by `cartSigningBytes`. */
  variant_id?: string | undefined
  /** Display-only label for the chosen variant (e.g. "11 / Black"). Deliberately
   * NOT part of `cartSigningBytes` — the signature's job is to pin down which SKU
   * and variant get bought, not to certify a human-readable string derived from it. */
  variant_label?: string | undefined
}

/** The derived lifecycle state of a mandate treated as a cumulative wallet, as
 * reported by the facilitator's read endpoints. Not a signed field — computed
 * from captured spend vs ceiling, expiry, and revocation. Shared here so the
 * facilitator and every client agree on the exact set of states. `error` is the
 * read-path's defense-in-depth value for a row whose stored intent can't be
 * parsed; it never describes a live mandate. */
export type MandateWalletState = 'active' | 'consumed' | 'expired' | 'revoked' | 'error'

/** A concrete purchase the agent is proposing, chained to its authorizing intent by hash. */
export type CartMandate = {
  cartId: string
  merchant_id: string
  items: CartItem[]
  total_paise: number
  intent_hash_hex: string
  agent_sig_hex: string
}

/** Canonical bytes covered by the human's intent signature — everything in `IntentMandate` but `sig`. */
export function intentSigningBytes(intent: Omit<IntentMandate, 'sig'>): Uint8Array {
  // Optional policy fields are included ONLY when present, so an intent without
  // them signs byte-identically to the pre-policy shape (existing mandates keep
  // verifying). canonicalJson sorts keys, so position here doesn't matter.
  return canonicalJson({
    mandateId: intent.mandateId,
    goal: intent.goal,
    ceiling_paise: intent.ceiling_paise,
    approval_threshold_paise: intent.approval_threshold_paise,
    currency: intent.currency,
    merchants: intent.merchants,
    expires_at: intent.expires_at,
    agent_pubkey_hex: intent.agent_pubkey_hex,
    ...(intent.per_merchant_ceiling_paise
      ? { per_merchant_ceiling_paise: intent.per_merchant_ceiling_paise }
      : {}),
    ...(intent.cumulative_approval_threshold_paise !== undefined
      ? { cumulative_approval_threshold_paise: intent.cumulative_approval_threshold_paise }
      : {}),
    ...(intent.goal_keywords ? { goal_keywords: intent.goal_keywords } : {}),
  })
}

/** Canonical bytes signed by the agent's cart signature — everything in `CartMandate` but `agent_sig_hex`. */
export function cartSigningBytes(cart: Omit<CartMandate, 'agent_sig_hex'>): Uint8Array {
  return canonicalJson({
    cartId: cart.cartId,
    merchant_id: cart.merchant_id,
    items: cart.items.map((item) => ({
      sku: item.sku,
      qty: item.qty,
      unit_price_paise: item.unit_price_paise,
      // Spread, not a plain field: canonicalJson throws on an explicit `undefined`
      // leaf, and omitting the key entirely (rather than emitting `variant_id:
      // null`) is what keeps a no-variant cart's signed bytes byte-identical to
      // the pre-variant shape — see the field's doc comment above.
      ...(item.variant_id ? { variant_id: item.variant_id } : {}),
    })),
    total_paise: cart.total_paise,
    intent_hash_hex: cart.intent_hash_hex,
  })
}
