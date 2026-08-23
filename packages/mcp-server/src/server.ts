/**
 * Builds the Hundi MCP server: the safe counterpart to a raw payment-API MCP
 * server. Every tool here is a shopping tool (browse stores, search products,
 * request a purchase, check an order) — none of them can approve a mandate,
 * revoke a mandate, issue a refund, or call a payment provider directly. `request_purchase`
 * is the one money-adjacent tool, and it only ever proposes a cart to the
 * facilitator's deterministic mandate gate; the facilitator decides, and a human
 * decides anything the facilitator parks as `pending_approval`.
 *
 * Transport-agnostic on purpose: `index.ts` wires this to stdio for real use,
 * tests wire it to an in-memory transport pair. Both get the identical tool set.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { BuyerTools } from '../../../agents/scripted-brain/src/agent-tools.js'
import { HttpBuyerTools } from '../../../agents/scripted-brain/src/agent-tools.js'
import type { AgentKeypair } from '../../../agents/scripted-brain/src/ed25519.js'
import { createFacilitatorClient, type FacilitatorClient } from './facilitator-client.js'
import { registerGetAgentIdentityTool } from './tools/get-agent-identity.js'
import { registerGetOrderTool } from './tools/get-order.js'
import { registerGetStoreInfoTool } from './tools/get-store-info.js'
import { registerListStoresTool } from './tools/list-stores.js'
import { registerPrepareMandateTool } from './tools/prepare-mandate.js'
import { registerRequestPurchaseTool } from './tools/request-purchase.js'
import { registerSearchProductsTool } from './tools/search-products.js'

// Bumped alongside package.json's version — there's no build step wiring the two
// together (see the note on JSON imports in packages/mcp-server/README.md).
export const SERVER_VERSION = '0.1.0'

const SERVER_INSTRUCTIONS =
  'Hundi is the safe counterpart to a raw payment-API MCP server: every tool here is a shopping ' +
  'tool, never a payment tool. This server holds one persistent Ed25519 "agent" keypair, distinct ' +
  'from any human key. It can search real stores and request purchases, but every purchase passes ' +
  "the Hundi facilitator's deterministic mandate checks (spending ceiling, merchant scope, " +
  'expiry, revocation, exact price match against the live catalog) before any money moves, and a ' +
  "purchase above the mandate's auto-approval threshold is parked for a human to approve in the " +
  'Hundi dashboard. When no mandate exists yet, call prepare_mandate to propose one from a plain-' +
  'language request (e.g. "give yourself ₹5000 to shop Frido, no approvals") — it only stages an ' +
  'inert draft and returns a link for the human to tap "Approve" on; this server cannot sign or ' +
  'approve that draft itself. This server cannot approve a mandate, revoke a mandate, issue a ' +
  'refund, or call a payment provider directly — those capabilities do not exist on any tool ' +
  "here. Start by calling get_agent_identity to learn this agent's public key and see what it is " +
  'already authorized to spend.'

export type HundiServerDeps = {
  agent: AgentKeypair
  facilitatorUrl: string
  /** Injectable for tests; defaults to a real HTTP client against `facilitatorUrl`. */
  facilitatorClient?: FacilitatorClient
  /** Injectable for tests; defaults to a real `HttpBuyerTools` against `facilitatorUrl` — the
   * same class every other buyer brain in this repo signs and settles carts through. */
  buyerTools?: Pick<BuyerTools, 'requestPayment'>
}

export function createHundiMcpServer(deps: HundiServerDeps): McpServer {
  const facilitatorClient = deps.facilitatorClient ?? createFacilitatorClient(deps.facilitatorUrl)
  const buyerTools =
    deps.buyerTools ??
    new HttpBuyerTools({
      storeUrl: deps.facilitatorUrl,
      facilitatorUrl: deps.facilitatorUrl,
      // HttpBuyerTools' own defaults (2s total, 10ms between polls) are tuned for
      // synchronous test executors. A real settlement can run a headless-browser
      // checkout against Razorpay, which routinely takes tens of seconds — poll
      // for up to 90s so request_purchase has a realistic chance to observe a
      // terminal state instead of reporting a mid-flight `settling` timeout.
      pollIntervalMs: 1_000,
      pollTimeoutMs: 90_000,
    })

  const server = new McpServer(
    { name: 'hundi', version: SERVER_VERSION },
    { instructions: SERVER_INSTRUCTIONS },
  )

  registerGetAgentIdentityTool(server, { agent: deps.agent, facilitatorClient })
  registerListStoresTool(server, { facilitatorClient })
  registerGetStoreInfoTool(server, { facilitatorClient })
  registerSearchProductsTool(server, { facilitatorClient })
  registerPrepareMandateTool(server, { agent: deps.agent, facilitatorClient })
  registerRequestPurchaseTool(server, { agent: deps.agent, facilitatorClient, buyerTools })
  registerGetOrderTool(server, { facilitatorClient })

  return server
}
