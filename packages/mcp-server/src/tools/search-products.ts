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
        'availability. A result that has size/color choices also includes `options` (the choice ' +
        'axes, e.g. Size) and `variants` (each choice with its own price and availability) — pass ' +
        'the size/color the shopper wants as `size`/`color`/`variant` to request_purchase to buy a ' +
        'specific one; a listing with no `variants` field has no size/color choice to make. The sku ' +
        'and merchant_id from a result here are what request_purchase needs — the price you see is ' +
        'always re-read from the catalog at purchase time, so it can never go stale between a ' +
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
          ...(p.variants
            ? {
                variants: p.variants.map((v) => ({
                  variant_id: v.variant_id,
                  label: v.label,
                  option_values: v.option_values,
                  price_paise: v.price_paise,
                  price_display: formatRupees(v.price_paise),
                  available: v.available,
                })),
              }
            : {}),
        })),
      })
    },
  )
}
