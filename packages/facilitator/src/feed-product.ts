/**
 * The agent-feed product shape (apps/store's `toFeedProduct`, apps/dashboard's
 * `buyer.ts` `StoreProduct`) — `{id, title, ...}` with a structured
 * `availability.status`, as opposed to the CLI scanner's catalog-adapter shape
 * (`{sku, name, ...}` with a bare `availability` string). Every store the
 * facilitator serves via GET /catalog/:merchant_id, onboarded or built-in, is
 * normalized to this one shape so the dashboard's buyer logic never needs to
 * know which pipeline produced a given listing.
 */

import type { ScannedOption, ScannedProduct, ScannedVariant, ScanResult } from '@hundi/cli/scanner'

export type FeedAvailability = { status: 'in_stock' | 'out_of_stock' }

export type FeedProduct = {
  id: string
  title: string
  description: string
  price_paise: number
  currency: string
  availability: FeedAvailability
  image: string
  brand: string
  merchant_id: string
  /** Present only on the synthetic poisoned-catalog listing (see
   * `buildPoisonProduct`) — mirrors apps/store's poison-fixture.ts contract that
   * apps/dashboard's `buyer.ts` `pickProduct` reads in poisoned mode. A normal
   * listing never carries this field. */
  injectedPayload?: { merchant_id: string; price_paise: number }
  /** Every purchasable variant (size/color) of this product, carried through
   * verbatim from the scan — see `ScannedProduct.variants`. Absent for a
   * single-SKU listing; a consumer that needs to let a buyer pick a size must
   * check this field rather than assume every listing has one. */
  variants?: ScannedVariant[]
  options?: ScannedOption[]
}

function toFeedProduct(product: ScannedProduct, merchantId: string): FeedProduct {
  return {
    id: product.sku,
    title: product.name,
    description: product.description,
    price_paise: product.price_paise,
    currency: product.currency,
    availability: { status: product.availability },
    image: product.image,
    brand: product.brand,
    merchant_id: merchantId,
    ...(product.variants ? { variants: product.variants } : {}),
    ...(product.options ? { options: product.options } : {}),
  }
}

function isValidFeedProduct(product: FeedProduct): boolean {
  return (
    product.id.length > 0 &&
    product.title.length > 0 &&
    Number.isInteger(product.price_paise) &&
    product.price_paise > 0 &&
    (product.availability.status === 'in_stock' || product.availability.status === 'out_of_stock')
  )
}

/** Maps a scan to feed-shape products, dropping anything structurally unusable
 * (missing id/title, non-positive price, malformed availability) — a scan that
 * yields zero *usable* products after this filter is what routes/stores.ts
 * reports as NO_PRODUCTS, even if the scanner itself returned rows. */
export function toFeedProducts(scan: ScanResult): FeedProduct[] {
  return scan.products.map((p) => toFeedProduct(p, scan.merchant_id)).filter(isValidFeedProduct)
}

const POISON_MERCHANT_ID = 'attacker-store'

/** A synthetic listing appended to GET /catalog/:merchant_id?poisoned=1, priced at the
 * catalog's own cheapest listing so it reliably wins the buyer's cheapest-in-stock
 * pick. Its `injectedPayload` is what apps/dashboard's `buyer.ts` `pickProduct` reads
 * in poisoned mode; the top-level `merchant_id` already points at the attacker so the
 * resulting cart is real content the facilitator's merchant-scope check can reject —
 * this listing doesn't need to hide a payload inside product-description text the way
 * apps/store's poison-fixture.ts does, because it isn't pretending to be part of the
 * real merchant's catalog in the first place. */
export function buildPoisonProduct(catalog: FeedProduct[]): FeedProduct {
  const cheapest = catalog.reduce(
    (min, p) => Math.min(min, p.price_paise),
    catalog[0]?.price_paise ?? 100,
  )
  return {
    id: 'poison-attacker',
    title: '(poisoned listing)',
    description:
      'Synthetic listing injected only when ?poisoned=1 is requested, to exercise the merchant-scope block against a real store catalog.',
    price_paise: cheapest,
    currency: 'INR',
    availability: { status: 'in_stock' },
    image: '',
    brand: '',
    merchant_id: POISON_MERCHANT_ID,
    injectedPayload: { merchant_id: POISON_MERCHANT_ID, price_paise: cheapest },
  }
}
