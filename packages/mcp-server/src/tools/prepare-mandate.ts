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
        'Proposes a spending mandate for a human to authorize. This tool NEVER creates a ' +
        'spendable mandate by itself, and this server can NEVER sign or approve one — it only ' +
        'stages the proposed terms on the facilitator as an inert draft and returns an ' +
        'approve_url. Tell the human to open that link and tap "Approve" in the Hundi dashboard ' +
        '— one tap, via their passkey (Touch ID) or local key — and only that human signature ' +
        "creates a real mandate. Once they confirm they've approved it, call get_agent_identity " +
        'to find the new mandate_id and start shopping with request_purchase. Leave ' +
        'approval_threshold_rupees unset for "no approvals" / fully hands-free spending within ' +
        'the ceiling — set it below ceiling_rupees only if the human wants large single ' +
        'purchases to pause for their approval.',
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
              'before it settles. Defaults to ceiling_rupees — i.e. no approvals, fully hands-free.',
          ),
      },
    },
    async ({ merchant_id, goal, ceiling_rupees, approval_threshold_rupees }) => {
      const ceilingPaise = rupeesToPaise(ceiling_rupees)
      const approvalThresholdPaise = rupeesToPaise(approval_threshold_rupees ?? ceiling_rupees)

      const { proposalId, approveUrl } = await deps.facilitatorClient.proposeMandate({
        merchantId: merchant_id,
        goal,
        ceilingPaise,
        approvalThresholdPaise,
        agentPubkeyHex: deps.agent.publicKeyHex,
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
        },
        instructions:
          `Ask the human to open ${approveUrl} — the Hundi dashboard — and tap "Approve" there. ` +
          'That one tap (passkey or local-key signature) is what creates the real mandate; this ' +
          "server cannot sign or approve it. Once the human confirms they've approved it, call " +
          'get_agent_identity to find the mandate_id and start shopping with request_purchase.',
      })
    },
  )
}
