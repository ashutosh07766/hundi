/** Test-only fixture builders — not a *.test.ts file, so vitest's `src/__tests__/**\/*.test.ts`
 * include pattern never runs this directly; it's imported by the suites that do. */

import type { IntentMandate } from '@hundi/core'
import { intentSigningBytes } from '@hundi/core'
import type { Product } from '../../../../agents/scripted-brain/src/agent-tools.js'
import type { AgentKeypair } from '../../../../agents/scripted-brain/src/ed25519.js'
import { generateAgentKeypair, signPayload } from '../../../../agents/scripted-brain/src/ed25519.js'

/** Builds a human-signed IntentMandate that attests `agent.publicKeyHex` as the cart
 * signer — the same two-key shape `session.ts`'s real ceremony produces. */
export function makeSignedIntent(opts: {
  agent: AgentKeypair
  human?: AgentKeypair
  overrides?: Partial<Omit<IntentMandate, 'sig' | 'agent_pubkey_hex'>>
}): { intent: IntentMandate; human: AgentKeypair } {
  const human = opts.human ?? generateAgentKeypair()
  const unsigned: Omit<IntentMandate, 'sig'> = {
    mandateId: 'mandate-1',
    goal: 'buy running shoes',
    ceiling_paise: 500_000,
    approval_threshold_paise: 200_000,
    currency: 'INR',
    merchants: ['demo-store-1'],
    expires_at: 4_000_000_000,
    agent_pubkey_hex: opts.agent.publicKeyHex,
    ...opts.overrides,
  }
  const sig = signPayload(human.privateKey, intentSigningBytes(unsigned))
  return { intent: { ...unsigned, sig }, human }
}

/** The GET /mandates row shape (mandate-repo.ts's stored columns), pre-serialized. */
export function mandateRow(args: {
  mandateId: string
  intent: IntentMandate
  revokedAt?: number | null
  createdAt?: number
}): { mandate_id: string; intent_json: string; revoked_at: number | null; created_at: number } {
  return {
    mandate_id: args.mandateId,
    intent_json: JSON.stringify(args.intent),
    revoked_at: args.revokedAt ?? null,
    created_at: args.createdAt ?? 1,
  }
}

export function catalogProduct(overrides: Partial<Product> = {}): Product {
  return {
    id: 'sku-001',
    title: 'Velocity Air Runner',
    description: 'Lightweight everyday trainer.',
    price_paise: 320_000,
    currency: 'INR',
    availability: { status: 'in_stock' },
    image: 'http://127.0.0.1:8791/img/sku-001',
    brand: 'Velocity Run',
    merchant_id: 'demo-store-1',
    ...overrides,
  }
}
