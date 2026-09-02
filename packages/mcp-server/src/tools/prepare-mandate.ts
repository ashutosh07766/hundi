/**
 * prepare_mandate — the conversational counterpart to the dashboard's manual mandate
 * ceremony. An LLM calls this to turn a plain-language request ("give yourself ₹5000
 * to shop Frido, no approvals") into a proposal a human can act on with one tap. This
 * tool only ever POSTs to the facilitator's /mandates/propose — an inert staging
 * draft that binds no credential and grants no spending authority. It structurally
 * cannot create a spendable mandate: that only happens when a human opens the
 * returned approve_url and signs the proposed terms with their own credential
 * (passkey or local key) in the Hundi dashboard, which registers the real mandate
 * through the existing POST /mandates ceremony-token flow — a path this server never
 * touches (see facilitator-client.ts's `listMandates`/`getCatalog`/`getSettlement`;
 * there is no sign-and-register method anywhere in this package).
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { AgentKeypair } from '../../../../agents/scripted-brain/src/ed25519.js'
import type { FacilitatorClient } from '../facilitator-client.js'
import { formatRupees } from '../format.js'
import { jsonResult } from '../tool-result.js'

function rupeesToPaise(rupees: number): number {
  return Math.round(rupees * 100)
}

export function registerPrepareMandateTool(
  server: McpServer,
  deps: { agent: AgentKeypair; facilitatorClient: FacilitatorClient },
): void {
  server.registerTool(
    'prepare_mandate',
    {
      title: 'Prepare mandate',
      description:
        'For requests like "give yourself ₹X to shop <store>", "set up a budget", "create a ' +
        'mandate", or "let me buy things through you" — stages the proposed terms on the ' +
        'facilitator as an inert draft (binds no credential, grants no spending authority) and ' +
        'returns a one-tap approve_url. The user opens that link and taps "Approve" in the Hundi ' +
        'dashboard (passkey/Touch ID or local key); that single human signature is what creates ' +
        'the real, spendable mandate — this server has no method that can sign or approve one ' +
        'itself, so staging a proposal here takes nothing away from the human. ' +
        '"No approvals" / "hands-free" describes leaving approval_threshold_rupees unset: it ' +
        'defaults to ceiling_rupees, meaning no PER-PURCHASE approval checkpoints after the ' +
        'initial tap — the human still authorizes the whole budget with that one signature, it ' +
        'just removes per-purchase pauses rather than the human step. Set ' +
        'approval_threshold_rupees below ceiling_rupees when the user wants purchases above a ' +
        "line to pause for their approval instead. Once the user confirms they've approved, call " +
        'get_agent_identity to find the new mandate_id, then shop with request_purchase. Can also ' +
        'set per-merchant sub-limits (per_merchant_ceiling_rupees) when the user wants to split a ' +
        'multi-store budget unevenly, and a cumulative approval line ' +
        '(cumulative_approval_threshold_rupees) that pauses for approval once TOTAL spend would ' +
        'cross it — closing the gap a per-purchase threshold alone leaves open, where many small ' +
        'purchases can otherwise drain the whole ceiling hands-free. Can also restrict the mandate ' +
        'to a stated purpose with goal_keywords, so a "running shoes" budget cannot quietly buy a ' +
        'blender — any purchase whose product does not match a keyword is rejected.',
      inputSchema: {
        merchant_id: z
          .string()
          .min(1)
          .describe('The merchant_id from list_stores — the one store this mandate authorizes.'),
        goal: z.string().min(1).describe('Plain-language description of what this budget is for.'),
        ceiling_rupees: z
          .number()
          .positive()
          .describe('Total the agent may ever spend under this mandate, in rupees.'),
        approval_threshold_rupees: z
          .number()
          .nonnegative()
          .optional()
          .describe(
            'Per-purchase line (in rupees) above which a human must approve in the dashboard ' +
              'before it settles. Defaults to ceiling_rupees — i.e. no approvals, fully hands-free. ' +
              'This only pauses an INDIVIDUAL purchase that exceeds it — it does not cap how much ' +
              'can be spent hands-free in total: many separate purchases each under the threshold ' +
              'can still exhaust the whole ceiling with zero approvals.',
          ),
        per_merchant_ceiling_rupees: z
          .record(z.string().min(1), z.number().positive())
          .optional()
          .describe(
            'Optional per-merchant sub-ceilings, in rupees, keyed by merchant_id. A merchant ' +
              'listed here can never be spent above its own entry, on top of (and never above) the ' +
              'global ceiling_rupees. A merchant not listed is bounded only by the global ceiling. ' +
              'Use this for "no more than ₹X at store A" style splits within one mandate.',
          ),
        cumulative_approval_threshold_rupees: z
          .number()
          .positive()
          .optional()
          .describe(
            'Optional cumulative approval line, in rupees. Once total captured spend under this ' +
              'mandate WOULD cross this line, the next purchase pauses for human approval — even ' +
              'if that purchase is itself under approval_threshold_rupees. Set this when the user ' +
              'wants a running-total safety line, not just a per-purchase one.',
          ),
        goal_keywords: z
          .array(z.string().min(1))
          .min(1)
          .optional()
          .describe(
            "Restrict this mandate to products matching these keywords — e.g. ['running shoe', " +
              "'sneaker', 'trainer']. A purchase whose product doesn't match any keyword is " +
              'rejected GOAL_MISMATCH. Omit for an unrestricted budget.',
          ),
      },
    },
    async ({
      merchant_id,
      goal,
      ceiling_rupees,
      approval_threshold_rupees,
      per_merchant_ceiling_rupees,
      cumulative_approval_threshold_rupees,
      goal_keywords,
    }) => {
      const ceilingPaise = rupeesToPaise(ceiling_rupees)
      const approvalThresholdPaise = rupeesToPaise(approval_threshold_rupees ?? ceiling_rupees)
      const perMerchantCeilingPaise = per_merchant_ceiling_rupees
        ? Object.fromEntries(
            Object.entries(per_merchant_ceiling_rupees).map(([merchantId, rupees]) => [
              merchantId,
              rupeesToPaise(rupees),
            ]),
          )
        : undefined
      const cumulativeApprovalThresholdPaise =
        cumulative_approval_threshold_rupees !== undefined
          ? rupeesToPaise(cumulative_approval_threshold_rupees)
          : undefined

      const { proposalId, approveUrl } = await deps.facilitatorClient.proposeMandate({
        merchantId: merchant_id,
        goal,
        ceilingPaise,
        approvalThresholdPaise,
        agentPubkeyHex: deps.agent.publicKeyHex,
        ...(perMerchantCeilingPaise ? { perMerchantCeilingPaise } : {}),
        ...(cumulativeApprovalThresholdPaise !== undefined
          ? { cumulativeApprovalThresholdPaise }
          : {}),
        ...(goal_keywords ? { goalKeywords: goal_keywords } : {}),
      })

      const handsFree = approvalThresholdPaise >= ceilingPaise

      return jsonResult({
        proposal_id: proposalId,
        approve_url: approveUrl,
        terms: {
          merchant_id,
          goal,
          ceiling_paise: ceilingPaise,
          approval_threshold_paise: approvalThresholdPaise,
          ceiling_display: formatRupees(ceilingPaise),
          approval_threshold_display: formatRupees(approvalThresholdPaise),
          approvals: handsFree
            ? 'none — fully hands-free within the ceiling'
            : `required above ${formatRupees(approvalThresholdPaise)}`,
          ...(perMerchantCeilingPaise
            ? {
                per_merchant_ceiling_paise: perMerchantCeilingPaise,
                per_merchant_ceiling_display: Object.fromEntries(
                  Object.entries(perMerchantCeilingPaise).map(([merchantId, paise]) => [
                    merchantId,
                    formatRupees(paise),
                  ]),
                ),
              }
            : {}),
          ...(cumulativeApprovalThresholdPaise !== undefined
            ? {
                cumulative_approval_threshold_paise: cumulativeApprovalThresholdPaise,
                cumulative_approval_threshold_display: formatRupees(
                  cumulativeApprovalThresholdPaise,
                ),
              }
            : {}),
          ...(goal_keywords ? { goal_keywords } : {}),
        },
        instructions:
          `Give the user this one-tap link and ask them to open it and tap "Approve": ${approveUrl} ` +
          `(the Hundi dashboard). ${
            handsFree
              ? 'They authorize the full budget once with that one tap; after that you shop within ' +
                'the ceiling with no further approvals.'
              : `Purchases up to ${formatRupees(approvalThresholdPaise)} then settle automatically; ` +
                'anything above pauses for their approval in the dashboard.'
          } That tap (passkey or local-key signature) is what creates the real mandate — this ` +
          'server cannot sign or approve it, so nothing here bypasses the user. This link is the ' +
          "complete mandate setup flow. Once they confirm they've approved, call " +
          'get_agent_identity to find the mandate_id and start shopping with request_purchase.',
      })
    },
  )
}
