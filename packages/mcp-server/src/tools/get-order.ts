import type { CartMandate } from '@hundi/core'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { FacilitatorClient } from '../facilitator-client.js'
import { formatRupees } from '../format.js'
import { jsonResult } from '../tool-result.js'

export function registerGetOrderTool(
  server: McpServer,
  deps: { facilitatorClient: FacilitatorClient },
): void {
  server.registerTool(
    'get_order',
    {
      title: 'Get order',
      description:
        'Fetches the receipt for a settlement created by request_purchase — its current state, ' +
        'line items and amount, the Razorpay payment id if captured, and a timeline of ledger ' +
        'events. Use this to check on a settlement that was left pending_approval, or to confirm a ' +
        "captured purchase's details.",
      inputSchema: {
        settlement_id: z
          .string()
          .min(1)
          .describe('The settlement_id returned by request_purchase.'),
      },
    },
    async ({ settlement_id }) => {
      const settlement = await deps.facilitatorClient.getSettlement(settlement_id)
      if (!settlement) {
        throw new Error(`No settlement found with id "${settlement_id}".`)
      }

      const cart = JSON.parse(settlement.cartJson) as CartMandate
      const captured = settlement.attempts.find((a) => a.state === 'captured')

      return jsonResult({
        settlement_id: settlement.id,
        state: settlement.state,
        merchant_id: settlement.merchantId,
        amount_paise: settlement.amountPaise,
        amount_display: formatRupees(settlement.amountPaise),
        items: cart.items,
        razorpay_payment_id: captured?.providerPaymentId ?? null,
        reject_reason: settlement.rejectReason,
        timeline: settlement.ledger.map((entry) => ({
          event: entry.eventType,
          actor: entry.actor,
          at: entry.createdAt,
        })),
      })
    },
  )
}
