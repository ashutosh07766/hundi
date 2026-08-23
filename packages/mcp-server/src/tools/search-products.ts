import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { ProductVariant } from '../../../../agents/scripted-brain/src/agent-tools.js'
import type { FacilitatorClient } from '../facilitator-client.js'
import { formatRupees } from '../format.js'
import { jsonResult } from '../tool-result.js'

const MAX_RESULTS = 25

/** Collapses a listing's full variant array into the handful of fields a shopper
 * actually needs to decide what to ask for — count, price spread, and the option
 * axes with their values (e.g. Size: 9–13) — instead of inlining every variant
 * object. request_purchase re-fetches and resolves the full catalog itself, so
 * this summary never needs to carry a `variant_id` for purchase to work. */
function summarizeVariants(variants: ProductVariant[]) {
  const prices = variants.map((v) => v.price_paise)
  const inStock = variants.filter((v) => v.available).length
  return {
    variant_count: variants.length,
    price_range: {
      min_paise: Math.min(...prices),
      max_paise: Math.max(...prices),
      display: `${formatRupees(Math.min(...prices))} – ${formatRupees(Math.max(...prices))}`,
    },
    in_stock_count: inStock,
  }
}

export function registerSearchProductsTool(
  server: McpServer,
  deps: { facilitatorClient: FacilitatorClient },
): void {
  server.registerTool(
    'search_products',
    {
      title: 'Search products',
      description:
        "Searches a store's live catalog (fetched fresh from the facilitator, never cached) for " +
        "products by title or brand. Omit `query` to list the store's catalog. Returns up to 25 " +
        'matches with sku, title, price (in paise and as a ₹ display string), brand, and ' +
        'availability. A result that has size/color choices also includes `options` (the choice ' +
        'axes and their values, e.g. Size: 9–13) and a `variant_summary` (count, price range, and ' +
        'how many are in stock) instead of every individual variant — pass the size/color the ' +
        'shopper wants as `size`/`color`/`variant` to request_purchase, which resolves the specific ' +
        'variant itself; a listing with no `variant_summary` has no size/color choice to make. The ' +
        'sku and merchant_id from a result here are what request_purchase needs — the price you see ' +
        'is always re-read from the catalog at purchase time, so it can never go stale between a ' +
        'search and a purchase.',
      inputSchema: {
        merchant_id: z.string().min(1).describe('A merchant_id from list_stores.'),
        query: z
          .string()
          .optional()
          .describe('Case-insensitive match against product title or brand. Omit to list all.'),
      },
    },
    async ({ merchant_id, query }) => {
      const products = await deps.facilitatorClient.getCatalog(merchant_id)
      const needle = query?.toLowerCase()
      const matches = needle
        ? products.filter(
            (p) => p.title.toLowerCase().includes(needle) || p.brand.toLowerCase().includes(needle),
          )
        : products

      return jsonResult({
        merchant_id,
        matched: matches.length,
        products: matches.slice(0, MAX_RESULTS).map((p) => ({
          sku: p.id,
          title: p.title,
          brand: p.brand,
          price_paise: p.price_paise,
          price_display: formatRupees(p.price_paise),
          availability: p.availability.status,
          ...(p.options ? { options: p.options } : {}),
          ...(p.variants && p.variants.length > 0
            ? {
                variant_summary: summarizeVariants(p.variants),
                variant_hint:
                  'Pass the specific size/color as size/color/variant to request_purchase — it ' +
                  'resolves the exact variant and its price at purchase time.',
              }
            : {}),
        })),
      })
    },
  )
}
