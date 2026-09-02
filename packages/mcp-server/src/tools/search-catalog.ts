import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { ProductVariant } from '../../../../agents/scripted-brain/src/agent-tools.js'
import type { FacilitatorClient } from '../facilitator-client.js'
import { formatRupees } from '../format.js'
import { jsonResult } from '../tool-result.js'

const PAISE_PER_RUPEE = 100

/** Collapses a listing's full variant array into the handful of fields a shopper
 * actually needs to decide what to ask for — count, price spread, and how many
 * are in stock — instead of inlining every variant object. Mirrors
 * search-products.ts's summarizeVariants; request_purchase re-resolves the
 * exact variant and its live price itself, so this summary never needs a
 * variant_id for a purchase to succeed. */
function summarizeVariants(variants: ProductVariant[]) {
  const prices = variants.map((v) => v.price_paise)
  return {
    variant_count: variants.length,
    price_range: {
      min_paise: Math.min(...prices),
      max_paise: Math.max(...prices),
      display: `${formatRupees(Math.min(...prices))} – ${formatRupees(Math.max(...prices))}`,
    },
    in_stock_count: variants.filter((v) => v.available).length,
  }
}

export function registerSearchCatalogTool(
  server: McpServer,
  deps: { facilitatorClient: FacilitatorClient },
): void {
  server.registerTool(
    'search_catalog',
    {
      title: 'Search catalog across stores',
      description:
        'Searches across every store the user has onboarded into Hundi — not the open internet, ' +
        'only the stores this facilitator already knows about (see list_stores for the full set). ' +
        'Returns matches ranked by relevance to the query, each with its merchant_id, title, price ' +
        '(in paise and as a ₹ display string), and availability. A result with size/color choices ' +
        'also includes a `variant_summary` (count, price range, how many are in stock) instead of ' +
        'every individual variant. To buy one, call request_purchase with its merchant_id and sku — ' +
        'that call needs a mandate already scoped to that specific store, so a result from a store ' +
        "outside the agent's current mandate can be searched here but can't be purchased until a " +
        'mandate covering it exists.',
      inputSchema: {
        query: z
          .string()
          .min(1)
          .describe('Search terms — matched against title, brand, and description.'),
        max_price_rupees: z
          .number()
          .positive()
          .optional()
          .describe('Drop any result priced above this many rupees.'),
        merchant_id: z
          .string()
          .min(1)
          .optional()
          .describe('Restrict the search to one store. Omit to search every onboarded store.'),
        in_stock_only: z
          .boolean()
          .optional()
          .describe('When true, drop any result that is currently out of stock.'),
        limit: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Maximum number of results to return (server caps at 100). Defaults to 25.'),
      },
    },
    async ({ query, max_price_rupees, merchant_id, in_stock_only, limit }) => {
      const results = await deps.facilitatorClient.searchCatalog({
        query,
        ...(max_price_rupees !== undefined
          ? { maxPricePaise: Math.round(max_price_rupees * PAISE_PER_RUPEE) }
          : {}),
        ...(merchant_id !== undefined ? { merchantId: merchant_id } : {}),
        ...(in_stock_only !== undefined ? { inStockOnly: in_stock_only } : {}),
        ...(limit !== undefined ? { limit } : {}),
      })

      return jsonResult({
        query,
        matched: results.length,
        results: results.map((p) => ({
          merchant_id: p.merchant_id,
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
