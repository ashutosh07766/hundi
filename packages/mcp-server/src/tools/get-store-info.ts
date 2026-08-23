import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { FacilitatorClient } from '../facilitator-client.js'
import { jsonResult } from '../tool-result.js'

const SAMPLE_SIZE = 5

export function registerGetStoreInfoTool(
  server: McpServer,
  deps: { facilitatorClient: FacilitatorClient },
): void {
  server.registerTool(
    'get_store_info',
    {
      title: 'Get store info',
      description:
        'Returns a quick profile of one store: display name, total product count, how many are ' +
        'currently in stock, and a small sample of product titles — useful for deciding whether a ' +
        'store is worth searching before calling search_products.',
      inputSchema: {
        merchant_id: z.string().min(1).describe('A merchant_id from list_stores.'),
      },
    },
    async ({ merchant_id }) => {
      const stores = await deps.facilitatorClient.listStores()
      const store = stores.find((s) => s.merchant_id === merchant_id)
      if (!store) {
        throw new Error(`No store with merchant_id "${merchant_id}". Call list_stores first.`)
      }

      const products = await deps.facilitatorClient.getCatalog(merchant_id)
      const inStockCount = products.filter((p) => p.availability.status === 'in_stock').length

      return jsonResult({
        merchant_id: store.merchant_id,
        name: store.name,
        product_count: store.product_count,
        in_stock_count: inStockCount,
        sample_products: products.slice(0, SAMPLE_SIZE).map((p) => p.title),
      })
    },
  )
}
