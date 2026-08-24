/**
 * list_orders — the spend-history read tool. Answers "what have you bought me?"
 * across a fresh session: it lists the settlements under mandates that authorize
 * THIS agent key, newest first, so the agent never has to already hold a
 * settlement_id (unlike get_order, which needs one). Read-only — like every
 * other tool here it cannot move money; it only reports what the facilitator
 * recorded. Scoped to this agent's own mandates so it can't enumerate another
 * agent's purchases even though GET /settlements is a global list.
 */

import type { CartMandate } from '@hundi/core'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { AgentKeypair } from '../../../../agents/scripted-brain/src/ed25519.js'
import type { FacilitatorClient } from '../facilitator-client.js'
import { formatRupees } from '../format.js'
import { jsonResult } from '../tool-result.js'

const DEFAULT_LIMIT = 20
const MAX_LIMIT = 100

export function registerListOrdersTool(
  server: McpServer,
  deps: { agent: AgentKeypair; facilitatorClient: FacilitatorClient },
): void {
  server.registerTool(
    'list_orders',
    {
      title: 'List orders',
      description:
        'Lists the purchases made under mandates that authorize this agent — newest first — so ' +
        'you can answer "what did you buy me?" without already holding a settlement_id. Each entry ' +
        'has the settlement_id, merchant, amount, current state (captured/pending_approval/' +
        'rejected/…), line items with any chosen size/color, and when it happened. Call get_order ' +
        'with a settlement_id for the full receipt (Razorpay payment id, ledger timeline). ' +
        "Read-only: this only reports recorded purchases and is scoped to this agent's own " +
        'mandates.',
      inputSchema: {
        limit: z
          .number()
          .int()
          .positive()
          .max(MAX_LIMIT)
          .optional()
          .describe(`Max orders to return, newest first. Defaults to ${DEFAULT_LIMIT}.`),
        state: z
          .string()
          .optional()
          .describe(
            'Optional filter on settlement state (e.g. "captured", "pending_approval", ' +
              '"rejected"). Omit to list every state.',
          ),
      },
    },
    async ({ limit, state }) => {
      const mandates = await deps.facilitatorClient.listMandates()
      const ownMandateIds = new Set(
        mandates
          .filter((m) => m.intent.agent_pubkey_hex === deps.agent.publicKeyHex)
          .map((m) => m.mandateId),
      )

      const settlements = await deps.facilitatorClient.listSettlements()
      // Newest first; listSettlements already returns created_at DESC, but sort
      // defensively so the contract doesn't depend on the endpoint's ordering.
      const scoped = settlements
        .filter((s) => ownMandateIds.has(s.mandateId))
        .filter((s) => (state ? s.state === state : true))
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, limit ?? DEFAULT_LIMIT)

      const orders = scoped.map((s) => {
        let items: CartMandate['items'] = []
        try {
          items = (JSON.parse(s.cartJson) as CartMandate).items ?? []
        } catch {
          // A settlement whose stored cart can't be parsed still lists — its
          // state/amount are the useful part; items just come back empty.
        }
        return {
          settlement_id: s.id,
          mandate_id: s.mandateId,
          merchant_id: s.merchantId,
          state: s.state,
          amount_paise: s.amountPaise,
          amount_display: formatRupees(s.amountPaise),
          created_at: s.createdAt,
          reject_reason: s.rejectReason,
          items: items.map((item) => ({
            sku: item.sku,
            qty: item.qty,
            ...(item.variant_label ? { variant: item.variant_label } : {}),
          })),
        }
      })

      return jsonResult({ count: orders.length, orders })
    },
  )
}
