// Test-only fixture builder for the HTTP layer. Signs with real ed25519 keys (via
// node:crypto's built-in Ed25519 support — no extra dependency needed) so the route
// tests exercise the actual signature-verification path, mirroring the discipline in
// packages/core/src/__tests__/fixtures.ts.

import crypto from 'node:crypto'
import type { CanonicalValue, CartItem, CartMandate, IntentMandate, SigEnvelope } from '@hundi/core'
import { canonicalJson, cartSigningBytes, intentSigningBytes, sha256Hex } from '@hundi/core'

export type Ed25519Keypair = { privateKey: crypto.KeyObject; publicKeyHex: string }

function base64UrlToHex(b64url: string): string {
  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/')
  return Buffer.from(b64, 'base64').toString('hex')
}

export function makeEd25519Keypair(): Ed25519Keypair {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519')
  const jwk = publicKey.export({ format: 'jwk' }) as { x: string }
  return { privateKey, publicKeyHex: base64UrlToHex(jwk.x) }
}

export function credentialFor(keypair: Ed25519Keypair): { type: 'ed25519'; publicKey_hex: string } {
  return { type: 'ed25519', publicKey_hex: keypair.publicKeyHex }
}

type Ed25519SigEnvelope = Extract<SigEnvelope, { type: 'ed25519' }>

/** Mirrors core's verifyEd25519: sign SHA-256(payloadBytes) with raw (Pure)Ed25519. */
export function signEnvelope(
  privateKey: crypto.KeyObject,
  payloadBytes: Uint8Array,
): Ed25519SigEnvelope {
  const digest = crypto.createHash('sha256').update(payloadBytes).digest()
  const signature = crypto.sign(null, digest, privateKey)
  return { type: 'ed25519', signature_hex: signature.toString('hex') }
}

export function signCanonical(
  privateKey: crypto.KeyObject,
  value: CanonicalValue,
): Ed25519SigEnvelope {
  return signEnvelope(privateKey, canonicalJson(value))
}

let mandateCounter = 0
function nextMandateId(): string {
  mandateCounter += 1
  return `mandate-${mandateCounter}`
}

export type MakeIntentOptions = {
  agent?: Ed25519Keypair
  overrides?: Partial<Omit<IntentMandate, 'sig'>>
}

export function makeIntent(opts: MakeIntentOptions = {}): {
  intent: IntentMandate
  agent: Ed25519Keypair
} {
  const agent = opts.agent ?? makeEd25519Keypair()
  const unsigned: Omit<IntentMandate, 'sig'> = {
    mandateId: nextMandateId(),
    goal: 'buy running shoes',
    ceiling_paise: 500_000,
    approval_threshold_paise: 200_000,
    currency: 'INR',
    merchants: ['merchant-1'],
    expires_at: 2_000_000_000,
    agent_pubkey_hex: agent.publicKeyHex,
    ...opts.overrides,
  }
  const sig = signEnvelope(agent.privateKey, intentSigningBytes(unsigned))
  return { intent: { ...unsigned, sig }, agent }
}

export type MakeCartOptions = {
  agent: Ed25519Keypair
  intent: IntentMandate
  items?: CartItem[]
  overrides?: Partial<Omit<CartMandate, 'agent_sig_hex' | 'items'>>
}

export function makeCart(opts: MakeCartOptions): CartMandate {
  const items = opts.items ?? [{ sku: 'sku-1', qty: 2, unit_price_paise: 100_000 }]
  const total = items.reduce((sum, i) => sum + i.qty * i.unit_price_paise, 0)
  const unsigned: Omit<CartMandate, 'agent_sig_hex'> = {
    cartId: 'cart-1',
    merchant_id: 'merchant-1',
    items,
    total_paise: total,
    intent_hash_hex: sha256Hex(intentSigningBytes(opts.intent)),
    ...opts.overrides,
  }
  const sig = signEnvelope(opts.agent.privateKey, cartSigningBytes(unsigned))
  return { ...unsigned, agent_sig_hex: sig.signature_hex }
}
