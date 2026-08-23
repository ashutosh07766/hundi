import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { FacilitatorClient } from '../facilitator-client.js'
import { formatRupees } from '../format.js'
import { jsonResult } from '../tool-result.js'

const MAX_RESULTS = 25

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
        'availability. The sku and merchant_id from a result here are what request_purchase needs ' +
        '— the price you see is always re-read from the catalog at purchase time, so it can never ' +
        'go stale between a search and a purchase.',
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
        })),
      })
    },
  )
}
