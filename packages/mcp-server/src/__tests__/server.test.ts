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
