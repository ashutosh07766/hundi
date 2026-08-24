import { cartSigningBytes, verifyMandateSignature } from '@hundi/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { HttpBuyerTools } from '../../../../agents/scripted-brain/src/agent-tools.js'
import { generateAgentKeypair } from '../../../../agents/scripted-brain/src/ed25519.js'
import { createFacilitatorClient } from '../facilitator-client.js'
import { createHundiMcpServer } from '../server.js'
import { fakeFacilitatorFetch, makeFakeFacilitatorState } from './fake-facilitator.js'
import { catalogProduct, makeSignedIntent, mandateRow } from './fixtures.js'
import { connectedClient, jsonOf } from './mcp-client.js'

const FACILITATOR_URL = 'http://fake-facilitator.test'

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})

function buildServer(
  state: ReturnType<typeof makeFakeFacilitatorState>,
  agent = generateAgentKeypair(),
) {
  globalThis.fetch = fakeFacilitatorFetch(state)
  const facilitatorClient = createFacilitatorClient(FACILITATOR_URL)
  const buyerTools = new HttpBuyerTools({
    storeUrl: FACILITATOR_URL,
    facilitatorUrl: FACILITATOR_URL,
  })
  const server = createHundiMcpServer({
    agent,
    facilitatorUrl: FACILITATOR_URL,
    facilitatorClient,
    buyerTools,
  })
  return { server, agent }
}

describe('list_stores', () => {
  it('maps the facilitator store list to merchant_id/name/product_count', async () => {
    const state = makeFakeFacilitatorState({
      stores: [{ merchant_id: 'demo-store-1', name: 'Hundi Demo Store', product_count: 20 }],
    })
    const { server } = buildServer(state)
    const client = await connectedClient(server)

    const result = await client.callTool({ name: 'list_stores', arguments: {} })
    expect(result.isError).toBeFalsy()
    expect(jsonOf(result)).toEqual([
      { merchant_id: 'demo-store-1', name: 'Hundi Demo Store', product_count: 20 },
    ])
  })
})

describe('search_products', () => {
  it('maps catalog rows and filters case-insensitively by title/brand', async () => {
    const state = makeFakeFacilitatorState({
      catalogs: {
        'demo-store-1': [
          catalogProduct({ id: 'sku-001', title: 'Velocity Air Runner', brand: 'Velocity Run' }),
          catalogProduct({ id: 'sku-002', title: 'Cloudstep Recovery', brand: 'Velocity Run' }),
        ],
      },
    })
    const { server } = buildServer(state)
    const client = await connectedClient(server)

    const all = jsonOf<{ matched: number; products: { sku: string }[] }>(
      await client.callTool({
        name: 'search_products',
        arguments: { merchant_id: 'demo-store-1' },
      }),
    )
    expect(all.matched).toBe(2)

    const filtered = jsonOf<{
      matched: number
      products: { sku: string; price_display: string }[]
    }>(
      await client.callTool({
        name: 'search_products',
        arguments: { merchant_id: 'demo-store-1', query: 'air runner' },
      }),
    )
    expect(filtered.matched).toBe(1)
    expect(filtered.products[0]?.sku).toBe('sku-001')
    expect(filtered.products[0]?.price_display).toContain('3,200')
  })

  it('surfaces an unknown merchant as a clean tool error', async () => {
    const state = makeFakeFacilitatorState({ catalogs: {} })
    const { server } = buildServer(state)
    const client = await connectedClient(server)

    const result = await client.callTool({
      name: 'search_products',
      arguments: { merchant_id: 'no-such-store' },
    })
    expect(result.isError).toBe(true)
  })
})

describe('get_agent_identity', () => {
  it("returns this agent's public key and the mandates that authorize it", async () => {
    const agent = generateAgentKeypair()
    const other = generateAgentKeypair()
    const { intent: ourIntent } = makeSignedIntent({
      agent,
      overrides: { mandateId: 'mandate-ours' },
    })
    const { intent: otherIntent } = makeSignedIntent({
      agent: other,
      overrides: { mandateId: 'mandate-other' },
    })
    const state = makeFakeFacilitatorState({
      mandates: [
        mandateRow({ mandateId: 'mandate-ours', intent: ourIntent }),
        mandateRow({ mandateId: 'mandate-other', intent: otherIntent }),
      ],
    })
    const { server } = buildServer(state, agent)
    const client = await connectedClient(server)

    const result = jsonOf<{
      agent_public_key_hex: string
      authorizing_mandates: { mandate_id: string }[]
    }>(await client.callTool({ name: 'get_agent_identity', arguments: {} }))

    expect(result.agent_public_key_hex).toBe(agent.publicKeyHex)
    expect(result.authorizing_mandates.map((m) => m.mandate_id)).toEqual(['mandate-ours'])
  })
})

describe('request_purchase', () => {
  let agent: ReturnType<typeof generateAgentKeypair>

  beforeEach(() => {
    agent = generateAgentKeypair()
  })

  it('builds a correctly-signed cart from catalog data, posts with an Idempotency-Key, and returns a captured summary', async () => {
    const { intent } = makeSignedIntent({ agent })
    const product = catalogProduct({ id: 'sku-001', price_paise: 320_000 })
    const state = makeFakeFacilitatorState({
      catalogs: { 'demo-store-1': [product] },
      mandates: [mandateRow({ mandateId: intent.mandateId, intent })],
      onCreateSettlement: () => ({
        status: 202,
        body: { ok: true, settlement_id: 'settlement-1', state: 'captured' },
      }),
      settlementsById: {
        'settlement-1': {
          ok: true,
          settlement: {
            id: 'settlement-1',
            mandate_id: intent.mandateId,
            state: 'captured',
            amount_paise: 320_000,
            merchant_id: 'demo-store-1',
            cart_json: '{}',
            reject_reason: null,
            created_at: 1,
          },
          attempts: [
            { state: 'captured', provider_payment_id: 'pay_test123', receipt: 'r1', created_at: 1 },
          ],
          ledger: [],
        },
      },
    })
    const { server } = buildServer(state, agent)
    const client = await connectedClient(server)

    const result = await client.callTool({
      name: 'request_purchase',
      arguments: {
        merchant_id: 'demo-store-1',
        sku: 'sku-001',
        qty: 1,
        mandate_id: intent.mandateId,
      },
    })
    expect(result.isError).toBeFalsy()

    const body = jsonOf<{ state: string; payment_id: string; settlement_id: string }>(result)
    expect(body.state).toBe('captured')
    expect(body.payment_id).toBe('pay_test123')
    expect(body.settlement_id).toBe('settlement-1')

    expect(state.createSettlementCalls).toHaveLength(1)
    const call = state.createSettlementCalls[0]
    if (!call) throw new Error('expected a POST /settlements call to have been recorded')
    expect(call.idempotencyKey).toBeTruthy()
    // The cart total/price came from the catalog fixture above, not from tool input —
    // proves request_purchase never trusts a caller-supplied price.
    expect(call.cart.total_paise).toBe(320_000)
    expect(
      verifyMandateSignature(
        cartSigningBytes(call.cart),
        { type: 'ed25519', signature_hex: call.cart.agent_sig_hex },
        {
          type: 'ed25519',
          publicKey_hex: agent.publicKeyHex,
        },
      ),
    ).toBe(true)
  })

  it('surfaces a facilitator rejection reason verbatim', async () => {
    const { intent } = makeSignedIntent({ agent, overrides: { ceiling_paise: 1_000 } })
    const product = catalogProduct({ id: 'sku-001', price_paise: 320_000 })
    const state = makeFakeFacilitatorState({
      catalogs: { 'demo-store-1': [product] },
      mandates: [mandateRow({ mandateId: intent.mandateId, intent })],
      onCreateSettlement: () => ({
        status: 202,
        body: {
          ok: true,
          settlement_id: 'settlement-2',
          state: 'rejected',
          reason: 'AMOUNT_EXCEEDS_CEILING',
        },
      }),
    })
    const { server } = buildServer(state, agent)
    const client = await connectedClient(server)

    const result = await client.callTool({
      name: 'request_purchase',
      arguments: { merchant_id: 'demo-store-1', sku: 'sku-001', mandate_id: intent.mandateId },
    })
    expect(result.isError).toBeFalsy()
    const body = jsonOf<{ state: string; reason: string; message: string }>(result)
    expect(body.state).toBe('rejected')
    expect(body.reason).toBe('AMOUNT_EXCEEDS_CEILING')
    expect(body.message).toContain('AMOUNT_EXCEEDS_CEILING')
  })

  it('tells the human where to approve a pending_approval purchase and never auto-approves', async () => {
    const { intent } = makeSignedIntent({ agent, overrides: { approval_threshold_paise: 1_000 } })
    const product = catalogProduct({ id: 'sku-001', price_paise: 320_000 })
    const state = makeFakeFacilitatorState({
      catalogs: { 'demo-store-1': [product] },
      mandates: [mandateRow({ mandateId: intent.mandateId, intent })],
      onCreateSettlement: () => ({
        status: 202,
        body: { ok: true, settlement_id: 'settlement-3', state: 'pending_approval' },
      }),
    })
    const { server } = buildServer(state, agent)
    const client = await connectedClient(server)

    const result = await client.callTool({
      name: 'request_purchase',
      arguments: { merchant_id: 'demo-store-1', sku: 'sku-001', mandate_id: intent.mandateId },
    })
    expect(result.isError).toBeFalsy()
    const body = jsonOf<{ state: string; message: string }>(result)
    expect(body.state).toBe('pending_approval')
    expect(body.message.toLowerCase()).toContain('dashboard')
    expect(body.message.toLowerCase()).toContain('pending approvals')
  })

  it('returns a clean tool error for an unknown mandate_id', async () => {
    const state = makeFakeFacilitatorState({
      catalogs: { 'demo-store-1': [catalogProduct()] },
      mandates: [],
    })
    const { server } = buildServer(state, agent)
    const client = await connectedClient(server)

    const result = await client.callTool({
      name: 'request_purchase',
      arguments: { merchant_id: 'demo-store-1', sku: 'sku-001', mandate_id: 'no-such-mandate' },
    })
    expect(result.isError).toBe(true)
  })

  it('returns a clean tool error for an unknown sku', async () => {
    const { intent } = makeSignedIntent({ agent })
    const state = makeFakeFacilitatorState({
      catalogs: { 'demo-store-1': [catalogProduct({ id: 'sku-001' })] },
      mandates: [mandateRow({ mandateId: intent.mandateId, intent })],
    })
    const { server } = buildServer(state, agent)
    const client = await connectedClient(server)

    const result = await client.callTool({
      name: 'request_purchase',
      arguments: { merchant_id: 'demo-store-1', sku: 'no-such-sku', mandate_id: intent.mandateId },
    })
    expect(result.isError).toBe(true)
  })

  it("refuses a mandate that does not authorize this agent's own key", async () => {
    const someoneElse = generateAgentKeypair()
    const { intent } = makeSignedIntent({ agent: someoneElse })
    const state = makeFakeFacilitatorState({
      catalogs: { 'demo-store-1': [catalogProduct()] },
      mandates: [mandateRow({ mandateId: intent.mandateId, intent })],
    })
    const { server } = buildServer(state, agent) // agent !== someoneElse
    const client = await connectedClient(server)

    const result = await client.callTool({
      name: 'request_purchase',
      arguments: { merchant_id: 'demo-store-1', sku: 'sku-001', mandate_id: intent.mandateId },
    })
    expect(result.isError).toBe(true)
    expect(state.createSettlementCalls).toHaveLength(0)
  })

  describe('variant resolution', () => {
    const variantProduct = () =>
      catalogProduct({
        id: 'shoes-1',
        title: 'Active Walking Shoes',
        price_paise: 320_000,
        variants: [
          {
            variant_id: 'v-9',
            label: '9',
            option_values: ['9'],
            price_paise: 300_000,
            available: true,
          },
          {
            variant_id: 'v-11',
            label: '11',
            option_values: ['11'],
            price_paise: 320_000,
            available: true,
          },
        ],
      })

    it('rejects a requested size that does not exist, lists real sizes, and builds no cart', async () => {
      const { intent } = makeSignedIntent({ agent })
      const state = makeFakeFacilitatorState({
        catalogs: { 'demo-store-1': [variantProduct()] },
        mandates: [mandateRow({ mandateId: intent.mandateId, intent })],
      })
      const { server } = buildServer(state, agent)
      const client = await connectedClient(server)

      const result = await client.callTool({
        name: 'request_purchase',
        arguments: {
          merchant_id: 'demo-store-1',
          sku: 'shoes-1',
          mandate_id: intent.mandateId,
          size: '13',
        },
      })
      expect(result.isError).toBeFalsy()
      const body = jsonOf<{ state: string; reason: string; message: string }>(result)
      expect(body.state).toBe('rejected')
      expect(body.reason).toBe('VARIANT_NOT_FOUND')
      expect(body.message).toContain('9')
      expect(body.message).toContain('11')
      expect(state.createSettlementCalls).toHaveLength(0)
    })

    it('resolves a requested size to its variant_id/variant_label and prices from the variant', async () => {
      const { intent } = makeSignedIntent({ agent })
      const state = makeFakeFacilitatorState({
        catalogs: { 'demo-store-1': [variantProduct()] },
        mandates: [mandateRow({ mandateId: intent.mandateId, intent })],
        onCreateSettlement: () => ({
          status: 202,
          body: { ok: true, settlement_id: 'settlement-variant-1', state: 'captured' },
        }),
        settlementsById: {
          'settlement-variant-1': {
            ok: true,
            settlement: {
              id: 'settlement-variant-1',
              mandate_id: intent.mandateId,
              state: 'captured',
              amount_paise: 300_000,
              merchant_id: 'demo-store-1',
              cart_json: '{}',
              reject_reason: null,
              created_at: 1,
            },
            attempts: [
              { state: 'captured', provider_payment_id: 'pay_v1', receipt: 'r1', created_at: 1 },
            ],
            ledger: [],
          },
        },
      })
      const { server } = buildServer(state, agent)
      const client = await connectedClient(server)

      const result = await client.callTool({
        name: 'request_purchase',
        arguments: {
          merchant_id: 'demo-store-1',
          sku: 'shoes-1',
          mandate_id: intent.mandateId,
          size: '9',
        },
      })
      expect(result.isError).toBeFalsy()
      const body = jsonOf<{ state: string; variant_id: string; variant_label: string }>(result)
      expect(body.state).toBe('captured')
      expect(body.variant_id).toBe('v-9')
      expect(body.variant_label).toBe('9')

      expect(state.createSettlementCalls).toHaveLength(1)
      const call = state.createSettlementCalls[0]
      if (!call) throw new Error('expected a POST /settlements call to have been recorded')
      // Priced from the variant (300_000), not the product's flat price_paise (320_000).
      expect(call.cart.total_paise).toBe(300_000)
      expect(call.cart.items[0]).toMatchObject({ variant_id: 'v-9', variant_label: '9' })
    })

    it('buys the base product with no variant recorded when no size/color/variant is requested (unchanged behavior)', async () => {
      const { intent } = makeSignedIntent({ agent })
      const state = makeFakeFacilitatorState({
        catalogs: { 'demo-store-1': [variantProduct()] },
        mandates: [mandateRow({ mandateId: intent.mandateId, intent })],
        onCreateSettlement: () => ({
          status: 202,
          body: { ok: true, settlement_id: 'settlement-variant-2', state: 'captured' },
        }),
        settlementsById: {
          'settlement-variant-2': {
            ok: true,
            settlement: {
              id: 'settlement-variant-2',
              mandate_id: intent.mandateId,
              state: 'captured',
              amount_paise: 320_000,
              merchant_id: 'demo-store-1',
              cart_json: '{}',
              reject_reason: null,
              created_at: 1,
            },
            attempts: [
              { state: 'captured', provider_payment_id: 'pay_v2', receipt: 'r1', created_at: 1 },
            ],
            ledger: [],
          },
        },
      })
      const { server } = buildServer(state, agent)
      const client = await connectedClient(server)

      const result = await client.callTool({
        name: 'request_purchase',
        arguments: { merchant_id: 'demo-store-1', sku: 'shoes-1', mandate_id: intent.mandateId },
      })
      expect(result.isError).toBeFalsy()

      expect(state.createSettlementCalls).toHaveLength(1)
      const call = state.createSettlementCalls[0]
      if (!call) throw new Error('expected a POST /settlements call to have been recorded')
      expect(call.cart.total_paise).toBe(320_000)
      expect(call.cart.items[0]).not.toHaveProperty('variant_id')
    })
  })
})

describe('get_order', () => {
  it('returns a receipt summary from a settlement', async () => {
    const state = makeFakeFacilitatorState({
      settlementsById: {
        'settlement-9': {
          ok: true,
          settlement: {
            id: 'settlement-9',
            mandate_id: 'mandate-1',
            state: 'captured',
            amount_paise: 320_000,
            merchant_id: 'demo-store-1',
            cart_json: JSON.stringify({
              cartId: 'c1',
              merchant_id: 'demo-store-1',
              items: [{ sku: 'sku-001', qty: 1, unit_price_paise: 320_000 }],
              total_paise: 320_000,
              intent_hash_hex: 'a'.repeat(64),
              agent_sig_hex: 'b'.repeat(128),
            }),
            reject_reason: null,
            created_at: 1,
          },
          attempts: [
            { state: 'captured', provider_payment_id: 'pay_abc', receipt: 'r1', created_at: 2 },
          ],
          ledger: [{ event_type: 'payment_captured', actor: 'executor', created_at: 2 }],
        },
      },
    })
    const { server } = buildServer(state)
    const client = await connectedClient(server)

    const result = await client.callTool({
      name: 'get_order',
      arguments: { settlement_id: 'settlement-9' },
    })
    expect(result.isError).toBeFalsy()
    const body = jsonOf<{ razorpay_payment_id: string; items: { sku: string }[] }>(result)
    expect(body.razorpay_payment_id).toBe('pay_abc')
    expect(body.items).toEqual([{ sku: 'sku-001', qty: 1, unit_price_paise: 320_000 }])
  })

  it('returns a clean tool error for an unknown settlement_id', async () => {
    const state = makeFakeFacilitatorState({})
    const { server } = buildServer(state)
    const client = await connectedClient(server)

    const result = await client.callTool({
      name: 'get_order',
      arguments: { settlement_id: 'no-such-settlement' },
    })
    expect(result.isError).toBe(true)
  })
})

describe('request_purchase — variant resolution, max price, idempotency', () => {
  const agent = generateAgentKeypair()

  const sneaker = () =>
    catalogProduct({
      id: 'sneaker',
      title: 'Frido Sneakers',
      price_paise: 449_900,
      options: [
        { name: 'Color', values: ['Leather Black', 'Leather Brown'] },
        { name: 'Size', values: ['10UK', '11UK'] },
      ],
      variants: [
        {
          variant_id: 'v-black-11',
          label: 'Leather Black / 11UK',
          option_values: ['Leather Black', '11UK'],
          price_paise: 449_900,
          available: true,
        },
        {
          variant_id: 'v-brown-11',
          label: 'Leather Brown / 11UK',
          option_values: ['Leather Brown', '11UK'],
          price_paise: 449_900,
          available: true,
        },
        {
          variant_id: 'v-black-10',
          label: 'Leather Black / 10UK',
          option_values: ['Leather Black', '10UK'],
          price_paise: 449_900,
          available: true,
        },
      ],
    })

  const capturedState = (intent: ReturnType<typeof makeSignedIntent>['intent']) =>
    makeFakeFacilitatorState({
      catalogs: { 'demo-store-1': [sneaker()] },
      mandates: [mandateRow({ mandateId: intent.mandateId, intent })],
      onCreateSettlement: () => ({
        status: 202,
        body: { ok: true, settlement_id: 'settlement-1', state: 'captured' },
      }),
      settlementsById: {
        'settlement-1': {
          ok: true,
          settlement: {
            id: 'settlement-1',
            mandate_id: intent.mandateId,
            state: 'captured',
            amount_paise: 449_900,
            merchant_id: 'demo-store-1',
            cart_json: '{}',
            reject_reason: null,
            created_at: 1,
          },
          attempts: [
            { state: 'captured', provider_payment_id: 'pay_1', receipt: 'r1', created_at: 1 },
          ],
          ledger: [],
        },
      },
    })

  it('resolves size + color order-insensitively (passed reversed vs the label)', async () => {
    const { intent } = makeSignedIntent({ agent })
    const state = capturedState(intent)
    const { server } = buildServer(state, agent)
    const client = await connectedClient(server)

    const result = await client.callTool({
      name: 'request_purchase',
      arguments: {
        merchant_id: 'demo-store-1',
        sku: 'sneaker',
        qty: 1,
        mandate_id: intent.mandateId,
        size: '11UK',
        color: 'Leather Black',
      },
    })
    expect(result.isError).toBeFalsy()
    const body = jsonOf<{ state: string; variant_id: string }>(result)
    expect(body.state).toBe('captured')
    expect(body.variant_id).toBe('v-black-11')
    expect(state.createSettlementCalls[0]?.cart.items[0]?.variant_id).toBe('v-black-11')
  })

  it('fails loud with VARIANT_NOT_FOUND for a nonexistent size and posts nothing', async () => {
    const { intent } = makeSignedIntent({ agent })
    const state = capturedState(intent)
    const { server } = buildServer(state, agent)
    const client = await connectedClient(server)

    const result = await client.callTool({
      name: 'request_purchase',
      arguments: {
        merchant_id: 'demo-store-1',
        sku: 'sneaker',
        qty: 1,
        mandate_id: intent.mandateId,
        size: '99UK',
      },
    })
    const body = jsonOf<{ state: string; reason: string }>(result)
    expect(body.state).toBe('rejected')
    expect(body.reason).toBe('VARIANT_NOT_FOUND')
    expect(state.createSettlementCalls).toHaveLength(0)
  })

  it('refuses MAX_PRICE_EXCEEDED when the catalog total is above max_price_paise, posting nothing', async () => {
    const { intent } = makeSignedIntent({ agent })
    const state = capturedState(intent)
    const { server } = buildServer(state, agent)
    const client = await connectedClient(server)

    const result = await client.callTool({
      name: 'request_purchase',
      arguments: {
        merchant_id: 'demo-store-1',
        sku: 'sneaker',
        qty: 1,
        mandate_id: intent.mandateId,
        variant_id: 'v-black-11',
        max_price_paise: 400_000,
      },
    })
    const body = jsonOf<{ state: string; reason: string }>(result)
    expect(body.state).toBe('rejected')
    expect(body.reason).toBe('MAX_PRICE_EXCEEDED')
    expect(state.createSettlementCalls).toHaveLength(0)
  })

  it('gives two identical purchases (no token) DISTINCT keys and carts, so a repeat buy settles independently', async () => {
    const { intent } = makeSignedIntent({ agent })
    const state = capturedState(intent)
    const { server } = buildServer(state, agent)
    const client = await connectedClient(server)
    const args = {
      merchant_id: 'demo-store-1',
      sku: 'sneaker',
      qty: 1,
      mandate_id: intent.mandateId,
      variant_id: 'v-black-11',
    }

    await client.callTool({ name: 'request_purchase', arguments: args })
    await client.callTool({ name: 'request_purchase', arguments: args })

    // Without an idempotency_token, a repeat purchase of the same item is a NEW
    // purchase — distinct keys and distinct signed carts, so it does not replay
    // the first as a fake success.
    expect(state.createSettlementCalls).toHaveLength(2)
    expect(state.createSettlementCalls[0]?.idempotencyKey).not.toBe(
      state.createSettlementCalls[1]?.idempotencyKey,
    )
    expect(state.createSettlementCalls[0]?.cart.cartId).not.toBe(
      state.createSettlementCalls[1]?.cart.cartId,
    )
  })

  it('reuses the key + cart across calls that share an idempotency_token, so a true retry dedupes', async () => {
    const { intent } = makeSignedIntent({ agent })
    const state = capturedState(intent)
    const { server } = buildServer(state, agent)
    const client = await connectedClient(server)
    const args = {
      merchant_id: 'demo-store-1',
      sku: 'sneaker',
      qty: 1,
      mandate_id: intent.mandateId,
      variant_id: 'v-black-11',
      idempotency_token: 'attempt-abc',
    }

    await client.callTool({ name: 'request_purchase', arguments: args })
    await client.callTool({ name: 'request_purchase', arguments: args })

    // Same token → identical Idempotency-Key and identical cart id, so a real
    // facilitator replays the first response rather than charging twice.
    expect(state.createSettlementCalls[0]?.idempotencyKey).toBe(
      state.createSettlementCalls[1]?.idempotencyKey,
    )
    expect(state.createSettlementCalls[0]?.cart.cartId).toBe(
      state.createSettlementCalls[1]?.cart.cartId,
    )
  })

  it('rejects an ambiguous free-text variant substring instead of silently picking the first match', async () => {
    const { intent } = makeSignedIntent({ agent })
    const state = capturedState(intent)
    const { server } = buildServer(state, agent)
    const client = await connectedClient(server)

    // "1" substring-matches all three variants (11UK, 11UK, 10UK all contain "1") —
    // must fail loud rather than silently settling on whichever comes first.
    const result = await client.callTool({
      name: 'request_purchase',
      arguments: {
        merchant_id: 'demo-store-1',
        sku: 'sneaker',
        qty: 1,
        mandate_id: intent.mandateId,
        variant: '1',
      },
    })
    expect(result.isError).toBeFalsy()
    const body = jsonOf<{ state: string; reason: string; message: string }>(result)
    expect(body.state).toBe('rejected')
    expect(body.reason).toBe('VARIANT_NOT_FOUND')
    expect(body.message).toContain('3 variants')
    expect(state.createSettlementCalls).toHaveLength(0)
  })

  it('reports a contested idempotency key (409 IN_FLIGHT) as ambiguous, never a terminal rejection', async () => {
    const { intent } = makeSignedIntent({ agent })
    const state = makeFakeFacilitatorState({
      catalogs: { 'demo-store-1': [sneaker()] },
      mandates: [mandateRow({ mandateId: intent.mandateId, intent })],
      onCreateSettlement: () => ({
        status: 409,
        body: { ok: false, error: 'IN_FLIGHT' },
      }),
    })
    const { server } = buildServer(state, agent)
    const client = await connectedClient(server)

    const result = await client.callTool({
      name: 'request_purchase',
      arguments: {
        merchant_id: 'demo-store-1',
        sku: 'sneaker',
        qty: 1,
        mandate_id: intent.mandateId,
        variant_id: 'v-black-11',
      },
    })
    expect(result.isError).toBeFalsy()
    const body = jsonOf<{ state: string; reason: string; message: string }>(result)
    expect(body.state).toBe('ambiguous')
    expect(body.reason).toBe('IN_FLIGHT')
    expect(body.message.toLowerCase()).toContain('get_order')
    // Not the terminal wording used for an actual rejection/failure/abandonment —
    // this state must read as unresolved, not as a confirmed non-charge.
    expect(body.message).not.toContain('Not completed')
    expect(state.createSettlementCalls).toHaveLength(1)
  })

  it('reports a contested idempotency key (409 KEY_REUSED) as ambiguous, never a terminal rejection', async () => {
    const { intent } = makeSignedIntent({ agent })
    const state = makeFakeFacilitatorState({
      catalogs: { 'demo-store-1': [sneaker()] },
      mandates: [mandateRow({ mandateId: intent.mandateId, intent })],
      onCreateSettlement: () => ({
        status: 409,
        body: { ok: false, error: 'KEY_REUSED' },
      }),
    })
    const { server } = buildServer(state, agent)
    const client = await connectedClient(server)

    const result = await client.callTool({
      name: 'request_purchase',
      arguments: {
        merchant_id: 'demo-store-1',
        sku: 'sneaker',
        qty: 1,
        mandate_id: intent.mandateId,
        variant_id: 'v-black-11',
        idempotency_token: 'attempt-conflict',
      },
    })
    expect(result.isError).toBeFalsy()
    const body = jsonOf<{ state: string; reason: string }>(result)
    expect(body.state).toBe('ambiguous')
    expect(body.reason).toBe('KEY_REUSED')
  })

  it('makes the token key price-independent, so a retry after a catalog price move still dedupes', async () => {
    const { intent } = makeSignedIntent({ agent })
    const state = capturedState(intent)
    const { server } = buildServer(state, agent)
    const client = await connectedClient(server)
    const args = {
      merchant_id: 'demo-store-1',
      sku: 'sneaker',
      qty: 1,
      mandate_id: intent.mandateId,
      variant_id: 'v-black-11',
      idempotency_token: 'attempt-xyz',
    }

    await client.callTool({ name: 'request_purchase', arguments: args })
    const keyBefore = state.createSettlementCalls[0]?.idempotencyKey

    // Catalog price ticks up between the purchase and its retry.
    const bumped = sneaker()
    bumped.price_paise = 459_900
    for (const v of bumped.variants ?? []) v.price_paise = 459_900
    state.catalogs = { 'demo-store-1': [bumped] }

    await client.callTool({ name: 'request_purchase', arguments: args })
    const keyAfter = state.createSettlementCalls[1]?.idempotencyKey

    // Key is derived from the token, not the (now-changed) cart bytes, so the
    // retry still carries the original key and dedupes instead of double-charging.
    expect(keyAfter).toBe(keyBefore)
  })
})

describe('list_orders', () => {
  const cartJson = (sku: string, variantLabel?: string) =>
    JSON.stringify({
      cartId: `cart-${sku}`,
      merchant_id: 'demo-store-1',
      items: [
        {
          sku,
          qty: 1,
          unit_price_paise: 100_000,
          ...(variantLabel ? { variant_label: variantLabel } : {}),
        },
      ],
      total_paise: 100_000,
      intent_hash_hex: 'h',
      agent_sig_hex: 's',
    })

  it("lists only this agent's purchases, newest first, with variant labels", async () => {
    const agent = generateAgentKeypair()
    const other = generateAgentKeypair()
    const { intent: mine } = makeSignedIntent({ agent, overrides: { mandateId: 'mandate-mine' } })
    const { intent: theirs } = makeSignedIntent({
      agent: other,
      overrides: { mandateId: 'mandate-other' },
    })
    const state = makeFakeFacilitatorState({
      mandates: [
        mandateRow({ mandateId: 'mandate-mine', intent: mine }),
        mandateRow({ mandateId: 'mandate-other', intent: theirs }),
      ],
      settlementsList: [
        {
          id: 's-old',
          mandate_id: 'mandate-mine',
          state: 'captured',
          amount_paise: 100_000,
          merchant_id: 'demo-store-1',
          cart_json: cartJson('sneaker', 'Black / 11UK'),
          created_at: 100,
          reject_reason: null,
        },
        {
          id: 's-new',
          mandate_id: 'mandate-mine',
          state: 'pending_approval',
          amount_paise: 100_000,
          merchant_id: 'demo-store-1',
          cart_json: cartJson('socks'),
          created_at: 200,
          reject_reason: null,
        },
        {
          id: 's-theirs',
          mandate_id: 'mandate-other',
          state: 'captured',
          amount_paise: 100_000,
          merchant_id: 'demo-store-1',
          cart_json: cartJson('not-mine'),
          created_at: 300,
          reject_reason: null,
        },
      ],
    })
    const { server } = buildServer(state, agent)
    const client = await connectedClient(server)

    const body = jsonOf<{
      count: number
      orders: { settlement_id: string; state: string; items: { sku: string; variant?: string }[] }[]
    }>(await client.callTool({ name: 'list_orders', arguments: {} }))

    // Only the two under mandate-mine, newest first; the other agent's is excluded.
    expect(body.count).toBe(2)
    expect(body.orders.map((o) => o.settlement_id)).toEqual(['s-new', 's-old'])
    expect(body.orders[1]?.items[0]).toMatchObject({ sku: 'sneaker', variant: 'Black / 11UK' })
  })

  it('filters by state when asked', async () => {
    const agent = generateAgentKeypair()
    const { intent } = makeSignedIntent({ agent, overrides: { mandateId: 'mandate-mine' } })
    const state = makeFakeFacilitatorState({
      mandates: [mandateRow({ mandateId: 'mandate-mine', intent })],
      settlementsList: [
        {
          id: 's-cap',
          mandate_id: 'mandate-mine',
          state: 'captured',
          amount_paise: 100_000,
          merchant_id: 'demo-store-1',
          cart_json: cartJson('a'),
          created_at: 1,
          reject_reason: null,
        },
        {
          id: 's-rej',
          mandate_id: 'mandate-mine',
          state: 'rejected',
          amount_paise: 100_000,
          merchant_id: 'demo-store-1',
          cart_json: cartJson('b'),
          created_at: 2,
          reject_reason: 'AMOUNT_EXCEEDS_CEILING',
        },
      ],
    })
    const { server } = buildServer(state, agent)
    const client = await connectedClient(server)

    const body = jsonOf<{ count: number; orders: { settlement_id: string }[] }>(
      await client.callTool({ name: 'list_orders', arguments: { state: 'captured' } }),
    )
    expect(body.count).toBe(1)
    expect(body.orders[0]?.settlement_id).toBe('s-cap')
  })
})

describe('onboard_store', () => {
  const makeOnboardServer = (
    state: ReturnType<typeof makeFakeFacilitatorState>,
    onboardToken?: string,
  ) => {
    globalThis.fetch = fakeFacilitatorFetch(state)
    return createHundiMcpServer({
      agent: generateAgentKeypair(),
      facilitatorUrl: FACILITATOR_URL,
      facilitatorClient: createFacilitatorClient(FACILITATOR_URL, onboardToken),
      buyerTools: new HttpBuyerTools({
        storeUrl: FACILITATOR_URL,
        facilitatorUrl: FACILITATOR_URL,
      }),
    })
  }

  it('scans with the onboard token (never the dashboard token) and returns the merchant_id', async () => {
    const state = makeFakeFacilitatorState({})
    const client = await connectedClient(makeOnboardServer(state, 'onboard-tok'))

    const body = jsonOf<{ ok: boolean; merchant_id: string; sample: string[] }>(
      await client.callTool({ name: 'onboard_store', arguments: { url: 'https://example.com' } }),
    )
    expect(body.ok).toBe(true)
    expect(body.merchant_id).toBe('example-com')
    expect(state.onboardCalls[0]).toMatchObject({
      url: 'https://example.com',
      onboardToken: 'onboard-tok',
    })
  })

  it('fails loud UNSUPPORTED_STORE when the store exposes no readable catalog', async () => {
    const state = makeFakeFacilitatorState({
      onboardResponse: { status: 400, body: { ok: false, error: 'NO_PRODUCTS', detail: 'none' } },
    })
    const client = await connectedClient(makeOnboardServer(state, 'onboard-tok'))

    const body = jsonOf<{ ok: boolean; reason: string }>(
      await client.callTool({ name: 'onboard_store', arguments: { url: 'https://puma.example' } }),
    )
    expect(body.ok).toBe(false)
    expect(body.reason).toBe('UNSUPPORTED_STORE')
  })

  it('reports onboarding as unconfigured (no facilitator call) when the server holds no onboard token', async () => {
    const state = makeFakeFacilitatorState({})
    const client = await connectedClient(makeOnboardServer(state))

    const body = jsonOf<{ ok: boolean; reason: string; message: string }>(
      await client.callTool({ name: 'onboard_store', arguments: { url: 'https://example.com' } }),
    )
    expect(body.ok).toBe(false)
    expect(body.reason).toBe('ONBOARD_FAILED')
    expect(state.onboardCalls).toHaveLength(0)
  })
})
