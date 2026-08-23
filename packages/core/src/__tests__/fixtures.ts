// Test-only fixture builder. Signs with real ed25519 keys so verify.test.ts exercises the
// actual signature path rather than a stub — a mock verifier would hide signature-format bugs.

import * as ed25519 from '@noble/ed25519'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import { sha256Hex } from '../hash.js'
import type { CartItem, CartMandate, IntentMandate } from '../mandate.js'
import { cartSigningBytes, intentSigningBytes } from '../mandate.js'
// Side-effect import: registers ed25519's sync SHA-512 provider before keygen()/sign() run below.
import '../signature.js'
import type { Credential } from '../signature.js'

export type Ed25519Keypair = { secretKey: Uint8Array; publicKeyHex: string }

export function makeEd25519Keypair(seed?: Uint8Array): Ed25519Keypair {
  const { secretKey, publicKey } = ed25519.keygen(seed)
  return { secretKey, publicKeyHex: bytesToHex(publicKey) }
}

export function credentialFor(keypair: Ed25519Keypair): Credential {
  return { type: 'ed25519', publicKey_hex: keypair.publicKeyHex }
}

const FIXED_AGENT = makeEd25519Keypair(new Uint8Array(32).fill(7))

export type MakeIntentOptions = {
  agent?: Ed25519Keypair
  overrides?: Partial<Omit<IntentMandate, 'sig'>>
}

export function makeIntent(opts: MakeIntentOptions = {}): {
  intent: IntentMandate
  agent: Ed25519Keypair
} {
  const agent = opts.agent ?? FIXED_AGENT
  const unsigned: Omit<IntentMandate, 'sig'> = {
    mandateId: 'mandate-1',
    goal: 'buy running shoes',
    ceiling_paise: 500_000,
    approval_threshold_paise: 200_000,
    currency: 'INR',
    merchants: ['merchant-1'],
    expires_at: 2_000_000_000,
    agent_pubkey_hex: agent.publicKeyHex,
    ...opts.overrides,
  }
  const signature = ed25519.sign(sha256(intentSigningBytes(unsigned)), agent.secretKey)
  const intent: IntentMandate = {
    ...unsigned,
    sig: { type: 'ed25519', signature_hex: bytesToHex(signature) },
  }
  return { intent, agent }
}

export type MakeCartOptions = {
  agent: Ed25519Keypair
  intent: IntentMandate
  items?: CartItem[]
  overrides?: Partial<Omit<CartMandate, 'sig' | 'agent_sig_hex' | 'items'>>
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
  const signature = ed25519.sign(sha256(cartSigningBytes(unsigned)), opts.agent.secretKey)
  return { ...unsigned, agent_sig_hex: bytesToHex(signature) }
}
