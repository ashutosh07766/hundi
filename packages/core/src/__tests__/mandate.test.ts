/** Unit tests for `cartSigningBytes` — specifically the two invariants the
 * variants feature depends on: a cart without `variant_id` must serialize
 * byte-identically to the pre-variant shape (every signature already recorded
 * against a live cart depends on this), and a cart with `variant_id` must
 * serialize to different bytes so the agent's signature actually covers the
 * chosen variant. `variant_label` is display-only and must never appear in
 * the signed bytes at all. */

import { describe, expect, it } from 'vitest'
import type { CartMandate } from '../mandate.js'
import { cartSigningBytes } from '../mandate.js'

type UnsignedCart = Omit<CartMandate, 'agent_sig_hex'>

const BASE_CART: UnsignedCart = {
  cartId: 'cart-1',
  merchant_id: 'merchant-1',
  items: [{ sku: 'sku-1', qty: 2, unit_price_paise: 100_000 }],
  total_paise: 200_000,
  intent_hash_hex: 'a'.repeat(64),
}

function decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes)
}

describe('cartSigningBytes — no variant_id (byte-compat regression guard)', () => {
  it('serializes to exactly the pre-variant canonical shape', () => {
    const text = decode(cartSigningBytes(BASE_CART))
    expect(text).toBe(
      '{"cartId":"cart-1","intent_hash_hex":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",' +
        '"items":[{"qty":2,"sku":"sku-1","unit_price_paise":100000}],"merchant_id":"merchant-1","total_paise":200000}',
    )
  })

  it('never emits a `variant_id` key, even as null, when the item has none', () => {
    const text = decode(cartSigningBytes(BASE_CART))
    expect(text).not.toContain('variant_id')
  })

  it('is unaffected by a `variant_label` with no `variant_id` alongside it', () => {
    // Guards the exact spread condition in cartSigningBytes: it keys off `variant_id`
    // truthiness, not "does the item have any variant field at all".
    const withLabelOnly: UnsignedCart = {
      ...BASE_CART,
      items: [{ ...BASE_CART.items[0]!, variant_label: 'Size 11' }],
    }
    expect(decode(cartSigningBytes(withLabelOnly))).toBe(decode(cartSigningBytes(BASE_CART)))
  })
})

describe('cartSigningBytes — with variant_id', () => {
  it('changes the signed bytes relative to the same cart without a variant', () => {
    const withVariant: UnsignedCart = {
      ...BASE_CART,
      items: [{ ...BASE_CART.items[0]!, variant_id: 'variant-11-black' }],
    }
    expect(decode(cartSigningBytes(withVariant))).not.toBe(decode(cartSigningBytes(BASE_CART)))
  })

  it('includes variant_id in the signed bytes, sorted alongside the other item keys', () => {
    const withVariant: UnsignedCart = {
      ...BASE_CART,
      items: [{ ...BASE_CART.items[0]!, variant_id: 'variant-11-black' }],
    }
    const text = decode(cartSigningBytes(withVariant))
    expect(text).toContain(
      '{"qty":2,"sku":"sku-1","unit_price_paise":100000,"variant_id":"variant-11-black"}',
    )
  })

  it('never includes variant_label in the signed bytes — it is display-only', () => {
    const withBoth: UnsignedCart = {
      ...BASE_CART,
      items: [
        { ...BASE_CART.items[0]!, variant_id: 'variant-11-black', variant_label: '11 / Black' },
      ],
    }
    const text = decode(cartSigningBytes(withBoth))
    expect(text).toContain('"variant_id":"variant-11-black"')
    expect(text).not.toContain('variant_label')
    expect(text).not.toContain('11 / Black')
  })
})
