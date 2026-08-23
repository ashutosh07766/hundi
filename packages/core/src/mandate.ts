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
  sig: SigEnvelope
}

export type CartItem = {
  sku: string
  qty: number
  unit_price_paise: number
}

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
  return canonicalJson({
    mandateId: intent.mandateId,
    goal: intent.goal,
    ceiling_paise: intent.ceiling_paise,
    approval_threshold_paise: intent.approval_threshold_paise,
    currency: intent.currency,
    merchants: intent.merchants,
    expires_at: intent.expires_at,
    agent_pubkey_hex: intent.agent_pubkey_hex,
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
    })),
    total_paise: cart.total_paise,
    intent_hash_hex: cart.intent_hash_hex,
  })
}
