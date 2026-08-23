/**
 * Pure schema.org JSON-LD renderers for the static site — no I/O, no
 * dependence on request context, so build.ts and tests can call these
 * directly. Deliberately shaped differently from apps/store's JSON-LD:
 * the index page carries every product in one `@graph` array (mixed with a
 * non-Product node, so a scanner's type filter has to do real work), each
 * product carries an explicit `sku` (apps/store has none and relies on
 * URL-derived fallback), and `offers` is an array rather than a bare object
 * — schema.org permits both shapes, only the array form is exercised here.
 * `itemCondition` and `aggregateRating` are included as fields no scanner
 * consuming name/sku/description/offers/image/brand needs to read.
 */

import type { Product } from './catalog.js'

const SCHEMA_CONTEXT = 'https://schema.org/'
const NEW_CONDITION = 'https://schema.org/NewCondition'

function priceString(pricePaise: number): string {
  return (pricePaise / 100).toFixed(2)
}

function availabilityUrl(availability: Product['availability']): string {
  return availability === 'in_stock'
    ? 'https://schema.org/InStock'
    : 'https://schema.org/OutOfStock'
}

export function productPageUrl(baseUrl: string, sku: string): string {
  return new URL(`product-${sku}.html`, baseUrl).toString()
}

function productNode(product: Product, baseUrl: string): Record<string, unknown> {
  return {
    '@type': 'Product',
    '@id': productPageUrl(baseUrl, product.sku),
    sku: product.sku,
    name: product.title,
    description: product.description,
    image: product.image,
    brand: { '@type': 'Brand', name: product.brand },
    itemCondition: NEW_CONDITION,
    aggregateRating: {
      '@type': 'AggregateRating',
      ratingValue: product.rating.value,
      reviewCount: product.rating.count,
    },
    offers: [
      {
        '@type': 'Offer',
        price: priceString(product.price_paise),
        priceCurrency: product.currency,
        availability: availabilityUrl(product.availability),
        itemCondition: NEW_CONDITION,
      },
    ],
  }
}

/** Every catalog product as one `@graph` array, headed by a `WebSite` node —
 * proves a scanner walks `@graph` and filters by `@type` rather than only
 * ever seeing a lone top-level Product. */
export function renderIndexJsonLd(products: readonly Product[], baseUrl: string): string {
  const graph = [
    { '@type': 'WebSite', name: 'Hundi Kitchenware Co.', url: baseUrl },
    ...products.map((p) => productNode(p, baseUrl)),
  ]
  return JSON.stringify({ '@context': SCHEMA_CONTEXT, '@graph': graph })
}

/** A single product's JSON-LD as a bare object (not wrapped in `@graph`) —
 * the shape apps/store also uses for its product pages, but with the extra
 * fields and array-form `offers` described above. */
export function renderProductJsonLd(product: Product, baseUrl: string): string {
  return JSON.stringify({ '@context': SCHEMA_CONTEXT, ...productNode(product, baseUrl) })
}
