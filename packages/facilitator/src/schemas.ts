/**
 * Zod schemas validating HTTP request bodies before they're cast to core's
 * `IntentMandate` / `CartMandate` / `Credential` / `SigEnvelope` types. Core
 * deliberately ships no schema layer of its own (it stays dependency-minimal
 * so it can run in any JS runtime) — this is the schema layer its own docs
 * say callers at an HTTP boundary must supply. `verifyChain`'s internal
 * SCHEMA_INVALID check still re-validates structurally regardless; this
 * layer exists to reject malformed JSON with a 400 before it reaches any
 * business logic, not to replace that check.
 */

import { z } from 'zod'

const jsonWebKeySchema = z.record(z.string(), z.unknown())

const sigEnvelopeSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ed25519'), signature_hex: z.string().min(1) }),
  z.object({
    type: z.literal('webauthn-es256'),
    clientDataJSON_b64u: z.string().min(1),
    authenticatorData_b64u: z.string().min(1),
    signature_b64u: z.string().min(1),
  }),
])

const credentialSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ed25519'), publicKey_hex: z.string().min(1) }),
  z.object({ type: z.literal('webauthn-es256'), publicKey_jwk: jsonWebKeySchema }),
])

const intentMandateSchema = z.object({
  mandateId: z.string().min(1),
  goal: z.string().min(1),
  ceiling_paise: z.number().int().positive(),
  approval_threshold_paise: z.number().int().nonnegative(),
  currency: z.literal('INR'),
  merchants: z.array(z.string().min(1)).min(1),
  expires_at: z.number().int(),
  agent_pubkey_hex: z.string().min(1),
  sig: sigEnvelopeSchema,
})

const cartItemSchema = z.object({
  sku: z.string().min(1),
  qty: z.number().int().min(1),
  unit_price_paise: z.number().int().positive(),
})

const cartMandateSchema = z.object({
  cartId: z.string().min(1),
  merchant_id: z.string().min(1),
  items: z.array(cartItemSchema).min(1),
  total_paise: z.number().int().nonnegative(),
  intent_hash_hex: z.string().min(1),
  agent_sig_hex: z.string().min(1),
})

export const mandatesBodySchema = z.object({
  intent: intentMandateSchema,
  credential: credentialSchema,
  // Missing/empty reads as an invalid token (401), not a malformed request (400) —
  // ceremony-token validity is a business check, not a shape check.
  ceremonyToken: z.string().default(''),
})

export const verifyBodySchema = z.object({
  intent: intentMandateSchema,
  cart: cartMandateSchema,
})

export const createSettlementBodySchema = z.object({
  intent: intentMandateSchema,
  cart: cartMandateSchema,
})

export const decisionBodySchema = z.object({
  payload: z.record(z.string(), z.unknown()),
  signature_hex: z.string().min(1),
})

export const approvalsBodySchema = z.object({
  settlement_id: z.string().min(1),
  mandate_cart_hash_hex: z.string().min(1),
  decision: z.enum(['approved', 'rejected']),
  sig: sigEnvelopeSchema,
})

export const revokeBodySchema = z.object({
  mandateId: z.string().min(1),
  sig: sigEnvelopeSchema,
})

export const storesOnboardBodySchema = z.object({
  url: z.string().min(1).url(),
})

export const adminMerchantBodySchema = z.object({
  merchant_id: z.string().min(1),
  name: z.string().min(1),
  catalog_url: z.string().min(1).optional(),
  config: z.object({
    catalogPrices: z.record(z.string(), z.number().int().positive()).optional(),
  }),
})
