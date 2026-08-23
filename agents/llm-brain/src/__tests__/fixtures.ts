/** Shared no-network fixtures for the llm-brain test suite: an in-memory
 * BuyerTools that never touches HTTP (built on scripted-brain's own
 * `buildCartDraft` so cart math stays identical to the real HttpBuyerTools),
 * a fake ChatClient that returns a scripted pick, and a minimal but
 * correctly-signed PurchaseMandate. */

import type { CanonicalValue, IntentMandate } from '@hundi/core'
import { intentSigningBytes } from '@hundi/core'
import type {
  Availability,
  BuyerTools,
  CartDraft,
  CartLineInput,
  Product,
  SettlementResult,
} from '../../../scripted-brain/src/agent-tools.js'
import { buildCartDraft } from '../../../scripted-brain/src/agent-tools.js'
import type { AgentKeypair } from '../../../scripted-brain/src/ed25519.js'
import { generateAgentKeypair, signPayload } from '../../../scripted-brain/src/ed25519.js'
import type { PurchaseMandate } from '../../../scripted-brain/src/scripted-brain.js'
import type { ChatClient } from '../llm-brain.js'

export function makeProduct(overrides: Partial<Product> = {}): Product {
  return {
    id: 'sku-1',
    title: 'Trail Runner',
    description: 'A cushioned trail running shoe.',
    price_paise: 200_000,
    currency: 'INR',
    availability: { status: 'in_stock' } satisfies Availability,
    image: 'https://example.test/shoe.png',
    brand: 'Acme',
    merchant_id: 'merchant-1',
    ...overrides,
  }
}

export function makeMandate(): PurchaseMandate {
  const agent = generateAgentKeypair()
  const human = generateAgentKeypair()
  const unsigned: Omit<IntentMandate, 'sig'> = {
    mandateId: `test-mandate-${Math.random()}`,
    goal: 'test goal',
    ceiling_paise: 500_000,
    approval_threshold_paise: 400_000,
    currency: 'INR',
    merchants: ['merchant-1'],
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    agent_pubkey_hex: agent.publicKeyHex,
  }
  const sig = signPayload(human.privateKey, intentSigningBytes(unsigned))
  const intent: IntentMandate = { ...unsigned, sig }
  return { intent, agent }
}

/** Returns a fake ChatClient whose single `chatJson` call always resolves to
 * `pick` — enough to exercise `askLlm`'s consumption of the client without
 * ever reaching the network. */
export function fakeChat(pick: {
  chosen_sku?: string
  reason?: string
  chosen_variant_id?: string
}): ChatClient {
  return {
    async chatJson() {
      return pick
    },
  }
}

export function pickOf(
  chosen_sku: string,
  reason = 'good fit',
): { chosen_sku: string; reason: string } {
  return { chosen_sku, reason }
}

export class FakeBuyerTools implements BuyerTools {
  readonly proposeCartCalls: Array<ReadonlyArray<CartLineInput>> = []
  readonly requestPaymentCalls: Array<{
    intent: IntentMandate
    cart: CartDraft
    agent: AgentKeypair
  }> = []
  readonly recordDecisionCalls: Array<{
    settlementId: string
    payload: Record<string, CanonicalValue>
    agent: AgentKeypair
  }> = []

  constructor(
    private readonly catalog: Product[],
    private readonly settlement: SettlementResult,
  ) {}

  async searchCatalog(): Promise<Product[]> {
    return this.catalog
  }

  async getProduct(id: string): Promise<Product> {
    const product = this.catalog.find((p) => p.id === id)
    if (!product) throw new Error(`FakeBuyerTools: no product ${id}`)
    return product
  }

  proposeCart(items: ReadonlyArray<CartLineInput>): CartDraft {
    this.proposeCartCalls.push(items)
    return buildCartDraft(items)
  }

  async requestPayment(args: {
    intent: IntentMandate
    cart: CartDraft
    agent: AgentKeypair
  }): Promise<SettlementResult> {
    this.requestPaymentCalls.push(args)
    return this.settlement
  }

  async recordDecision(args: {
    settlementId: string
    payload: Record<string, CanonicalValue>
    agent: AgentKeypair
  }): Promise<void> {
    this.recordDecisionCalls.push(args)
  }
}
