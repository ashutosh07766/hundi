/**
 * Structural guarantee, not a behavioral one: greps this package's own source for
 * any trace of the capabilities it must never expose — Razorpay credentials or its
 * client, a call to the facilitator's approve/revoke/refund routes, or a settlement-
 * execution symbol. This deliberately does NOT ban the word "razorpay" outright:
 * get_order's `razorpay_payment_id` is a legitimate read-only receipt field (the id
 * of an already-captured payment), not a capability. What must never appear is a
 * credential, a client, or a write-route literal that would let this server act as
 * one.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { HttpBuyerTools } from '../../../../agents/scripted-brain/src/agent-tools.js'
import { generateAgentKeypair } from '../../../../agents/scripted-brain/src/ed25519.js'
import { createFacilitatorClient } from '../facilitator-client.js'
import { createHundiMcpServer } from '../server.js'
import { fakeFacilitatorFetch, makeFakeFacilitatorState } from './fake-facilitator.js'
import { connectedClient } from './mcp-client.js'

const srcDir = fileURLToPath(new URL('..', import.meta.url))

const FORBIDDEN = [
  /RAZORPAY_KEY/, // provider credentials
  /RazorpayClient/, // the provider client type/class
  /createRazorpayClient/,
  /razorpay-client/, // the module that wraps the provider SDK
  /refundPayment/,
  /createPaymentLink/,
  /['"]\/approvals['"]/, // a literal fetch target for the approve/reject route
  /['"]\/revoke['"]/, // a literal fetch target for the revoke route
]

function walkTsFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry)
    const stat = statSync(full)
    if (stat.isDirectory()) out.push(...walkTsFiles(full))
    else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) out.push(full)
  }
  return out
}

describe('structural — no payment-provider or approval/revoke surface', () => {
  it('never references Razorpay credentials/client or the approve/revoke routes', () => {
    for (const file of walkTsFiles(srcDir)) {
      const source = readFileSync(file, 'utf8')
      for (const pattern of FORBIDDEN) {
        expect(
          pattern.test(source),
          `${path.relative(srcDir, file)} must not match ${pattern}`,
        ).toBe(false)
      }
    }
  })

  it('exposes exactly the six shopping tools — no approve/revoke/refund/settle tool exists', async () => {
    const agent = generateAgentKeypair()
    const state = makeFakeFacilitatorState({})
    const facilitatorUrl = 'http://fake-facilitator.test'
    const originalFetch = globalThis.fetch
    globalThis.fetch = fakeFacilitatorFetch(state)
    try {
      const server = createHundiMcpServer({
        agent,
        facilitatorUrl,
        facilitatorClient: createFacilitatorClient(facilitatorUrl),
        buyerTools: new HttpBuyerTools({ storeUrl: facilitatorUrl, facilitatorUrl }),
      })
      const client = await connectedClient(server)
      const { tools } = await client.listTools()
      expect(new Set(tools.map((t) => t.name))).toEqual(
        new Set([
          'get_agent_identity',
          'list_stores',
          'get_store_info',
          'search_products',
          'request_purchase',
          'get_order',
        ]),
      )
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
