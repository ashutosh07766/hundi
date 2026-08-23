/**
 * get_agent_identity — the onboarding tool. An LLM calls this first, relays the
 * public key to its human, and the human pastes it into a Hundi dashboard mandate
 * ceremony's "Agent public key" field. Nothing about registering, approving, or
 * revoking a mandate happens here or anywhere else in this server — that stays a
 * human-only action in the dashboard, by construction (no tool in this file exposes
 * a write path to /mandates, /approvals, or /revoke).
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { AgentKeypair } from '../../../../agents/scripted-brain/src/ed25519.js'
import type { FacilitatorClient } from '../facilitator-client.js'
import { formatRupees } from '../format.js'
import { jsonResult } from '../tool-result.js'

export function registerGetAgentIdentityTool(
  server: McpServer,
  deps: { agent: AgentKeypair; facilitatorClient: FacilitatorClient },
): void {
  server.registerTool(
    'get_agent_identity',
    {
      title: 'Get agent identity',
      description:
        "Returns this MCP server's Ed25519 public key — its shopping identity. Give this key " +
        'to the human operating this connection so they can authorize it in the Hundi dashboard: ' +
        'open a mandate ceremony and paste this value into the "Agent public key" field. This ' +
        'server can only spend under a mandate whose agent_pubkey_hex matches this key, and it ' +
        "structurally cannot approve or revoke a mandate — those actions require the human's own, " +
        'separate key and happen only in the dashboard. Also lists mandates currently authorizing ' +
        "this key with each one's authoritative wallet accounting — spent_paise, remaining_paise, " +
        'and state (active | consumed | expired | revoked). A mandate is a cumulative wallet: it ' +
        'stays spendable across multiple purchases until remaining_paise hits zero (state ' +
        'consumed) or it expires. Read remaining_paise/state directly — do not compute a balance ' +
        'by subtracting past purchases yourself.',
      inputSchema: {},
    },
    async () => {
      const publicKeyHex = deps.agent.publicKeyHex
      let mandates: Awaited<ReturnType<FacilitatorClient['listMandates']>> = []
      let mandateLookupError: string | undefined
      try {
        mandates = await deps.facilitatorClient.listMandates()
      } catch (err) {
        // Visible degradation: identity is still returned even if the facilitator
        // can't be reached to check which mandates authorize it.
        mandateLookupError = err instanceof Error ? err.message : String(err)
      }

      const authorizing = mandates
        .filter((m) => m.intent.agent_pubkey_hex === publicKeyHex)
        .map((m) => ({
          mandate_id: m.mandateId,
          goal: m.intent.goal,
          ceiling_paise: m.intent.ceiling_paise,
          approval_threshold_paise: m.intent.approval_threshold_paise,
          // Authoritative wallet accounting straight from the facilitator — report
          // `remaining_paise`/`state`, never a balance derived by subtracting here.
          // A mandate is a cumulative wallet: `state: consumed` means it's drained,
          // `remaining_paise` is what's left to spend before it is.
          spent_paise: m.spentPaise,
          remaining_paise: m.remainingPaise,
          remaining_display: formatRupees(m.remainingPaise),
          state: m.state,
          merchants: m.intent.merchants,
          expires_at: m.intent.expires_at,
          revoked: m.revoked,
        }))

      return jsonResult({
        agent_public_key_hex: publicKeyHex,
        instructions:
          'Give this public key to the human. They authorize it in the Hundi dashboard mandate ' +
          'ceremony. This server can never approve or revoke a mandate itself.',
        authorizing_mandates: authorizing,
        ...(mandateLookupError ? { mandate_lookup_error: mandateLookupError } : {}),
      })
    },
  )
}
