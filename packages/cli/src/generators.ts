/**
 * Pure file-content generators — no I/O, no fetch. `cli.ts` is the only
 * caller that writes their output to disk, which keeps these testable as
 * plain string/object producers.
 */

import type { Availability, ScanResult } from './scanner.js'

/** llmstxt.org format (https://llmstxt.org): H1 title, a blockquote summary,
 * then H2 sections. Agents fetch this first to orient before touching the
 * structured endpoints. */
export function generateLlmsTxt(store: ScanResult): string {
  const highlights = store.products
    .slice(0, 3)
    .map((p) => `- [${p.name}](${p.url})`)
    .join('\n')

  return `# ${store.merchant_id}

> A storefront scanned by Hundi: every product exposes machine-readable price, availability, and identity so an AI shopping agent can browse and buy without scraping HTML.

## Products

- Full catalog (JSON): ./catalog-adapter.json
${highlights}

## Buying

Agents should fetch the capability manifest at ./.well-known/hundi.json to discover the catalog endpoint, currency, and how to submit a cart to the Hundi facilitator for settlement.
`
}

export type HundiManifest = {
  version: string
  merchant_id: string
  catalog_endpoint: string
  product_endpoint: string
  currency: string
  facilitator_hint: string
}

/** The `/.well-known/hundi.json` shape — mirrors what a live store serves at
 * that path, but pointed at the generated static catalog file rather than a
 * live API, since a CLI-scanned store may have no server-side integration at
 * all yet. */
export function generateManifest(store: ScanResult): HundiManifest {
  return {
    version: '0.1',
    merchant_id: store.merchant_id,
    catalog_endpoint: './catalog-adapter.json',
    product_endpoint: './catalog-adapter.json',
    currency: store.products[0]?.currency ?? 'INR',
    facilitator_hint: 'submit carts to the Hundi facilitator',
  }
}

export type CatalogAdapterRow = {
  merchant_id: string
  sku: string
  name: string
  description: string
  price_paise: number
  currency: string
  availability: { status: Availability }
  image: string
  brand: string
}

export type CatalogAdapter = {
  merchant_id: string
  currency: string
  products: CatalogAdapterRow[]
}

/** ACP-shaped catalog feed (availability as `{status}`, not a bare boolean —
 * matches what `apps/store`'s `/api/catalog` serves live) for stores that
 * have no dynamic catalog endpoint of their own to point a facilitator at. */
export function generateCatalogAdapter(store: ScanResult): CatalogAdapter {
  return {
    merchant_id: store.merchant_id,
    currency: store.products[0]?.currency ?? 'INR',
    products: store.products.map((p) => ({
      merchant_id: store.merchant_id,
      sku: p.sku,
      name: p.name,
      description: p.description,
      price_paise: p.price_paise,
      currency: p.currency,
      availability: { status: p.availability },
      image: p.image,
      brand: p.brand,
    })),
  }
}
