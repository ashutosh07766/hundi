import type { CartMandate, IntentMandate } from '@hundi/core'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { FacilitatorClient, MandateRecord } from '../facilitator-client.js'
import { formatRupees } from '../format.js'
import { jsonResult } from '../tool-result.js'

// The two ledger events that only ever follow a `verifyChain(...) === { ok: true }`
// result (see packages/facilitator/src/settlement-service.ts): 'verify_passed' for
// the auto-approved path, 'approval_granted' for the human-approved path after
// 'approval_requested'. Either one is proof the deterministic mandate-chain gate
// accepted this cart — a rejected or still-pending settlement has neither.
const GATE_PASSED_EVENTS = new Set(['verify_passed', 'approval_granted'])

/** Plain-language rendering of the constraints an intent mandate carries, in the
 * order a merchant/judge would want to hear them: spend line, then narrower
 * scopes. Only emits a line for a constraint the intent actually sets. */
function describeConstraints(intent: IntentMandate): string[] {
  const constraints: string[] = [
    `requires human approval for any single cart over ${formatRupees(intent.approval_threshold_paise)}`,
  ]
  if (intent.per_merchant_ceiling_paise) {
    for (const [merchantId, limitPaise] of Object.entries(intent.per_merchant_ceiling_paise)) {
      constraints.push(`per-merchant ceiling of ${formatRupees(limitPaise)} at ${merchantId}`)
    }
  }
  if (intent.cumulative_approval_threshold_paise !== undefined) {
    constraints.push(
      'requires human approval once cumulative captured spend crosses ' +
        formatRupees(intent.cumulative_approval_threshold_paise),
    )
  }
  if (intent.allowed_skus && intent.allowed_skus.length > 0) {
    const n = intent.allowed_skus.length
    constraints.push(`restricted to ${n} specific product${n === 1 ? '' : 's'}`)
  }
  return constraints
}

/** Plain-language rendering of the guarantees `verifyChain` (packages/core/src/verify.ts)
 * structurally enforces on every cart that reaches a gate-passed state, in the same
 * fixed order that gate checks them. The base checks apply unconditionally — they
 * don't need the authorizing mandate's intent, only the fact that the gate ran and
 * passed. The merchant-scoped and SKU-restriction lines only appear when `intent`
 * is available AND actually carries that constraint — with no intent (mandate
 * lookup failed) or no constraint set, this never claims a check that didn't apply. */
function describeChecksPassed(merchantId: string, intent: IntentMandate | undefined): string[] {
  const checks = [
    "the human's mandate signature and the agent's cart signature both verified",
    'the cart is cryptographically chained to the authorizing mandate by hash',
    'the line-item total matches the sum of quantity × unit price',
    "unit prices were re-checked against the merchant's live catalog at settle time",
    "the merchant is within the mandate's authorized scope",
    'the mandate had not expired and was not revoked',
    "total spend stayed within the mandate's overall ceiling",
  ]
  const merchantLimit = intent?.per_merchant_ceiling_paise?.[merchantId]
  if (merchantLimit !== undefined) {
    checks.push(
      `spend at ${merchantId} stayed within its ${formatRupees(merchantLimit)} per-merchant ceiling`,
    )
  }
  checks.push('the cart was not a duplicate of an already-processed cart')
  if (intent?.allowed_skus && intent.allowed_skus.length > 0) {
    checks.push("the purchased sku is within the mandate's authorized product set")
  }
  return checks
}

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
        'events — plus an explanation/audit view: which mandate authorized the purchase and its ' +
        'active constraints, which deterministic gate checks passed, a note on the live-catalog ' +
        'price verification, the payment receipt, and the ledger timeline. Use this to check on a ' +
        "settlement that was left pending_approval, to confirm a captured purchase's details, or " +
        'to see exactly why a purchase was allowed.',
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

      const timeline = settlement.ledger.map((entry) => ({
        event: entry.eventType,
        actor: entry.actor,
        at: entry.createdAt,
      }))
      const gatePassed = settlement.ledger.some((entry) => GATE_PASSED_EVENTS.has(entry.eventType))

      // The mandate lookup is read-only context for the audit view, not part of the
      // receipt itself — a facilitator hiccup here must never fail the whole tool
      // call, only degrade this one section visibly.
      let mandateRecord: MandateRecord | undefined
      let explanationNote: string | undefined
      try {
        const mandates = await deps.facilitatorClient.listMandates()
        mandateRecord = mandates.find((m) => m.mandateId === settlement.mandateId)
        if (!mandateRecord) {
          explanationNote =
            `No mandate found with id "${settlement.mandateId}" — it may have been deleted, ` +
            'or this settlement predates the current mandate records.'
        }
      } catch (err) {
        explanationNote = `Could not look up the authorizing mandate: ${err instanceof Error ? err.message : String(err)}`
      }

      return jsonResult({
        settlement_id: settlement.id,
        state: settlement.state,
        merchant_id: settlement.merchantId,
        amount_paise: settlement.amountPaise,
        amount_display: formatRupees(settlement.amountPaise),
        items: cart.items,
        razorpay_payment_id: captured?.providerPaymentId ?? null,
        reject_reason: settlement.rejectReason,
        timeline,
        explanation: {
          authorized_by: mandateRecord
            ? {
                mandate_id: mandateRecord.mandateId,
                goal: mandateRecord.intent.goal,
                ceiling_paise: mandateRecord.intent.ceiling_paise,
                ceiling_display: formatRupees(mandateRecord.intent.ceiling_paise),
                constraints: describeConstraints(mandateRecord.intent),
              }
            : null,
          ...(explanationNote ? { explanation_note: explanationNote } : {}),
          checks_passed: gatePassed
            ? describeChecksPassed(settlement.merchantId, mandateRecord?.intent)
            : null,
          fresh_price: gatePassed
            ? `Unit prices in this cart were re-verified against ${settlement.merchantId}'s live ` +
              `catalog at settle time — the ${formatRupees(settlement.amountPaise)} charged is the ` +
              "merchant's catalog price, not merely what the agent asserted."
            : null,
          payment: {
            razorpay_payment_id: captured?.providerPaymentId ?? null,
            amount_paise: settlement.amountPaise,
            amount_display: formatRupees(settlement.amountPaise),
          },
          ledger_timeline: timeline,
        },
      })
    },
  )
}
