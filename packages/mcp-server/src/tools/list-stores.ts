import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { FacilitatorClient } from '../facilitator-client.js'
import { jsonResult } from '../tool-result.js'

export function registerListStoresTool(
  server: McpServer,
  deps: { facilitatorClient: FacilitatorClient },
): void {
  server.registerTool(
    'list_stores',
    {
      title: 'List stores',
      description:
        'Lists every store shoppable through Hundi — each one a real merchant onboarded to the ' +
        "facilitator. Returns each store's merchant_id (use this to search its products), display " +
        'name, and how many products it carries. Call this before search_products to find which ' +
        'merchant_id to search.',
      inputSchema: {},
    },
    async () => {
      const stores = await deps.facilitatorClient.listStores()
      return jsonResult(
        stores.map((s) => ({
          merchant_id: s.merchant_id,
          name: s.name,
          product_count: s.product_count,
        })),
      )
    },
  )
}
