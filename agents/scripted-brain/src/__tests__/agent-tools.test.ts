/** Unit tests for `buildCartDraft`'s variant resolution — the shared price/total
 * math every buyer brain (scripted, LLM, MCP) routes through. Covers: a plain
 * line item stays byte-identical to pre-variant behavior; a variant line prices
 * off the variant's own `price_paise`, not the product's; an unknown variantId
 * fails loud rather than silently falling back to the base SKU. */

import { describe, expect, it } from 'vitest'
import type { Product } from '../agent-tools.js'
import { buildCartDraft } from '../agent-tools.js'

function makeProduct(overrides: Partial<Product> = {}): Product {
  return {
    id: 'shoes-1',
    title: 'Active Walking Shoes',
    description: '',
    price_paise: 320_000,
    currency: 'INR',
    availability: { status: 'in_stock' },
    image: '',
    brand: 'Acme',
    merchant_id: 'merchant-1',
    ...overrides,
  }
}

describe('buildCartDraft — no variant (unchanged behavior)', () => {
  it('prices the line from the product itself and never emits variant_id/variant_label', () => {
    const product = makeProduct()
    const cart = buildCartDraft([{ product, qty: 2 }])
    expect(cart).toEqual({
      merchant_id: 'merchant-1',
      items: [{ sku: 'shoes-1', qty: 2, unit_price_paise: 320_000 }],
      total_paise: 640_000,
    })
  })
})

describe('buildCartDraft — with a resolved variant', () => {
  const withVariants = makeProduct({
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
        available: false,
      },
    ],
  })

  it('prices the line from the chosen variant, not the product-level price', () => {
    const cart = buildCartDraft([{ product: withVariants, qty: 1, variantId: 'v-9' }])
    expect(cart.items).toEqual([
      { sku: 'shoes-1', qty: 1, unit_price_paise: 300_000, variant_id: 'v-9', variant_label: '9' },
    ])
    expect(cart.total_paise).toBe(300_000)
  })

  it('throws — never silently substitutes the base SKU — when variantId does not resolve', () => {
    expect(() =>
      buildCartDraft([{ product: withVariants, qty: 1, variantId: 'does-not-exist' }]),
    ).toThrow(/variant "does-not-exist" not found/)
  })

  it('throws when variantId is given but the product has no variants at all', () => {
    const noVariants = makeProduct()
    expect(() => buildCartDraft([{ product: noVariants, qty: 1, variantId: 'v-1' }])).toThrow(
      /variant "v-1" not found/,
    )
  })
})
