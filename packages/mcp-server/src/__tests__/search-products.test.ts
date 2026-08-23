import { afterEach, describe, expect, it } from 'vitest'
import { generateAgentKeypair } from '../../../../agents/scripted-brain/src/ed25519.js'
import { createFacilitatorClient } from '../facilitator-client.js'
import { createHundiMcpServer } from '../server.js'
import { fakeFacilitatorFetch, makeFakeFacilitatorState } from './fake-facilitator.js'
import { catalogProduct } from './fixtures.js'
import { connectedClient, jsonOf } from './mcp-client.js'

const FACILITATOR_URL = 'http://fake-facilitator.test'

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})

function buildServer(state: ReturnType<typeof makeFakeFacilitatorState>) {
  globalThis.fetch = fakeFacilitatorFetch(state)
  const facilitatorClient = createFacilitatorClient(FACILITATOR_URL)
  const server = createHundiMcpServer({
    agent: generateAgentKeypair(),
    facilitatorUrl: FACILITATOR_URL,
    facilitatorClient,
  })
  return { server }
}

type SearchResultProduct = {
  sku: string
  title: string
  options?: { name: string; values: string[] }[]
  variant_summary?: { variant_count: number; price_range: unknown; in_stock_count: number }
  variant_hint?: string
  variants?: unknown
}

describe('search_products — variant summarization', () => {
  it('summarizes a multi-variant listing instead of inlining every variant', async () => {
    const state = makeFakeFacilitatorState({
      catalogs: {
        'demo-store-1': [
          catalogProduct({
            id: 'shoes-1',
            title: 'Active Walking Shoes',
            options: [{ name: 'Size', values: ['9', '11', '13'] }],
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
              {
                variant_id: 'v-13',
                label: '13',
                option_values: ['13'],
                price_paise: 340_000,
                available: false,
              },
            ],
          }),
        ],
      },
    })
    const { server } = buildServer(state)
    const client = await connectedClient(server)

    const body = jsonOf<{ products: SearchResultProduct[] }>(
      await client.callTool({
        name: 'search_products',
        arguments: { merchant_id: 'demo-store-1' },
      }),
    )

    const product = body.products[0]
    if (!product) throw new Error('expected one product')

    // Compact summary in place of the full variant array.
    expect(product.variants).toBeUndefined()
    expect(product.variant_summary).toEqual({
      variant_count: 3,
      price_range: {
        min_paise: 300_000,
        max_paise: 340_000,
        display: expect.stringContaining('3,000'),
      },
      in_stock_count: 2,
    })
    expect(product.options).toEqual([{ name: 'Size', values: ['9', '11', '13'] }])

    // A hint that the specific choice is made at purchase time via request_purchase.
    expect(product.variant_hint).toBeTruthy()
    expect(product.variant_hint?.toLowerCase()).toContain('request_purchase')
  })

  it('leaves a single-variant / no-variant product unchanged (no variant summary noise)', async () => {
    const state = makeFakeFacilitatorState({
      catalogs: {
        'demo-store-1': [catalogProduct({ id: 'sku-001', title: 'Velocity Air Runner' })],
      },
    })
    const { server } = buildServer(state)
    const client = await connectedClient(server)

    const body = jsonOf<{ products: SearchResultProduct[] }>(
      await client.callTool({
        name: 'search_products',
        arguments: { merchant_id: 'demo-store-1' },
      }),
    )

    const product = body.products[0]
    if (!product) throw new Error('expected one product')
    expect(product.variant_summary).toBeUndefined()
    expect(product.variant_hint).toBeUndefined()
    expect(product.options).toBeUndefined()
    expect(product.variants).toBeUndefined()
  })

  it('treats an empty variants array the same as no variants', async () => {
    const state = makeFakeFacilitatorState({
      catalogs: {
        'demo-store-1': [catalogProduct({ id: 'sku-001', variants: [] })],
      },
    })
    const { server } = buildServer(state)
    const client = await connectedClient(server)

    const body = jsonOf<{ products: SearchResultProduct[] }>(
      await client.callTool({
        name: 'search_products',
        arguments: { merchant_id: 'demo-store-1' },
      }),
    )

    const product = body.products[0]
    if (!product) throw new Error('expected one product')
    expect(product.variant_summary).toBeUndefined()
    expect(product.variant_hint).toBeUndefined()
  })
})
