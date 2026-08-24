/**
 * onboard_store — makes a public storefront shoppable by scanning its catalog.
 * This is NOT a money tool: it stores the store's product feed so search_products
 * and request_purchase can see it; it grants no spending authority and creates no
 * merchant relationship. Gated by a narrow onboard token the server holds, which
 * authorizes ONLY this scan — never mandate registration or approvals, so it
 * can't widen what the agent can spend. A human-signed mandate still gates every
 * purchase. Onboarding only supports storefronts that expose a machine-readable
 * catalog (schema.org product markup or a Shopify products feed); platforms that
 * expose neither fail loud rather than onboarding an empty store.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { FacilitatorClient } from '../facilitator-client.js'
import { jsonResult } from '../tool-result.js'

export function registerOnboardStoreTool(
  server: McpServer,
  deps: { facilitatorClient: FacilitatorClient },
): void {
  server.registerTool(
    'onboard_store',
    {
      title: 'Onboard store',
      description:
        'Point Hundi at a public storefront URL to make it shoppable — it scans the catalog and ' +
        'stores the products so search_products and request_purchase can use them. Returns the ' +
        'merchant_id to shop under, the product count, and a sample. This only reads a public ' +
        'catalog; it grants no spending authority and does not create a merchant relationship, so ' +
        'a purchase still needs a human-signed mandate scoped to the returned merchant_id. Works ' +
        'for stores exposing schema.org product data or a Shopify products feed; a store that ' +
        'exposes neither is reported as unsupported rather than onboarded empty. Note: in test ' +
        'mode a purchase settles a Razorpay TEST payment and does not place a real order at the ' +
        'merchant.',
      inputSchema: {
        url: z
          .string()
          .url()
          .describe('The storefront URL to scan, e.g. "https://in.example.com".'),
      },
    },
    async ({ url }) => {
      try {
        const result = await deps.facilitatorClient.onboardStore(url)
        return jsonResult({
          ok: true,
          merchant_id: result.merchantId,
          name: result.name,
          product_count: result.productCount,
          sample: result.sample,
          warnings: result.warnings,
          next: `Shop this store with search_products / request_purchase using merchant_id "${result.merchantId}". A purchase needs a mandate scoped to it (see prepare_mandate).`,
        })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        // Fail loud with the reason. NO_PRODUCTS means the store's platform exposes
        // no machine-readable catalog we can read (e.g. a custom/SFCC storefront) —
        // report it as unsupported rather than pretending it onboarded.
        return jsonResult({
          ok: false,
          reason: /NO_PRODUCTS/.test(message) ? 'UNSUPPORTED_STORE' : 'ONBOARD_FAILED',
          message: /NO_PRODUCTS/.test(message)
            ? `"${url}" could not be onboarded: it exposes no schema.org product data or Shopify ` +
              'products feed that Hundi can read. Hundi can only shop stores with a machine-readable ' +
              'catalog today.'
            : `Could not onboard "${url}": ${message}`,
        })
      }
    },
  )
}
