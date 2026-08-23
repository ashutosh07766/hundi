import { afterEach, describe, expect, it } from 'vitest'
import { generateAgentKeypair } from '../../../../agents/scripted-brain/src/ed25519.js'
import { createFacilitatorClient } from '../facilitator-client.js'
import { createHundiMcpServer } from '../server.js'
import { fakeFacilitatorFetch, makeFakeFacilitatorState } from './fake-facilitator.js'
import { connectedClient, jsonOf } from './mcp-client.js'

const FACILITATOR_URL = 'http://fake-facilitator.test'

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})

function buildServer(state: ReturnType<typeof makeFakeFacilitatorState>) {
  const agent = generateAgentKeypair()
  globalThis.fetch = fakeFacilitatorFetch(state)
  const facilitatorClient = createFacilitatorClient(FACILITATOR_URL)
  const server = createHundiMcpServer({
    agent,
    facilitatorUrl: FACILITATOR_URL,
    facilitatorClient,
  })
  return { server, agent }
}

describe('prepare_mandate', () => {
  it("posts the ceiling/threshold in paise and this server's own agent pubkey, and returns the approve_url", async () => {
    const state = makeFakeFacilitatorState({})
    const { server, agent } = buildServer(state)
    const client = await connectedClient(server)

    const result = await client.callTool({
      name: 'prepare_mandate',
      arguments: {
        merchant_id: 'demo-store-1',
        goal: 'shop Frido',
        ceiling_rupees: 5000,
        approval_threshold_rupees: 5000,
      },
    })
    expect(result.isError).toBeFalsy()

    const body = jsonOf<{
      proposal_id: string
      approve_url: string
      terms: { ceiling_paise: number; approval_threshold_paise: number; approvals: string }
    }>(result)
    expect(body.proposal_id).toBe('proposal-1')
    expect(body.approve_url).toBe('http://localhost:5173/?propose=proposal-1')
    expect(body.terms.ceiling_paise).toBe(500_000)
    expect(body.terms.approval_threshold_paise).toBe(500_000)
    expect(body.terms.approvals).toContain('hands-free')

    expect(state.proposeMandateCalls).toHaveLength(1)
    const call = state.proposeMandateCalls[0]
    if (!call) throw new Error('expected a POST /mandates/propose call to have been recorded')
    expect(call.merchant_id).toBe('demo-store-1')
    expect(call.goal).toBe('shop Frido')
    expect(call.ceiling_paise).toBe(500_000)
    expect(call.approval_threshold_paise).toBe(500_000)
    expect(call.agent_pubkey_hex).toBe(agent.publicKeyHex)
  })

  it('defaults approval_threshold_rupees to ceiling_rupees ("no approvals") when omitted', async () => {
    const state = makeFakeFacilitatorState({})
    const { server } = buildServer(state)
    const client = await connectedClient(server)

    const result = await client.callTool({
      name: 'prepare_mandate',
      arguments: { merchant_id: 'demo-store-1', goal: 'shop Frido', ceiling_rupees: 5000 },
    })
    expect(result.isError).toBeFalsy()

    const body = jsonOf<{
      terms: { ceiling_paise: number; approval_threshold_paise: number; approvals: string }
    }>(result)
    expect(body.terms.approval_threshold_paise).toBe(body.terms.ceiling_paise)
    expect(body.terms.approvals).toContain('hands-free')

    const call = state.proposeMandateCalls[0]
    if (!call) throw new Error('expected a POST /mandates/propose call to have been recorded')
    expect(call.approval_threshold_paise).toBe(call.ceiling_paise)
  })

  it('sets a lower threshold when the caller asks for above-threshold approvals', async () => {
    const state = makeFakeFacilitatorState({})
    const { server } = buildServer(state)
    const client = await connectedClient(server)

    const result = await client.callTool({
      name: 'prepare_mandate',
      arguments: {
        merchant_id: 'demo-store-1',
        goal: 'shop Frido',
        ceiling_rupees: 5000,
        approval_threshold_rupees: 1000,
      },
    })
    const body = jsonOf<{ terms: { approval_threshold_paise: number; approvals: string } }>(result)
    expect(body.terms.approval_threshold_paise).toBe(100_000)
    expect(body.terms.approvals).not.toContain('hands-free')
    expect(body.terms.approvals).toContain('required')
  })

  it('never implies the agent can sign or approve — routes the human to the dashboard instead', async () => {
    const state = makeFakeFacilitatorState({})
    const { server } = buildServer(state)
    const client = await connectedClient(server)

    const result = await client.callTool({
      name: 'prepare_mandate',
      arguments: { merchant_id: 'demo-store-1', goal: 'shop Frido', ceiling_rupees: 5000 },
    })
    const body = jsonOf<{ instructions: string }>(result)
    expect(body.instructions.toLowerCase()).toContain('cannot sign')
    expect(body.instructions).toContain('dashboard')
    expect(body.instructions).toContain('http://localhost:5173/?propose=proposal-1')
  })

  it('surfaces a facilitator rejection (e.g. unknown merchant) as a clean tool error', async () => {
    const state = makeFakeFacilitatorState({
      onProposeMandate: () => ({
        status: 400,
        body: { ok: false, error: 'UNKNOWN_MERCHANT', detail: 'no such store' },
      }),
    })
    const { server } = buildServer(state)
    const client = await connectedClient(server)

    const result = await client.callTool({
      name: 'prepare_mandate',
      arguments: { merchant_id: 'no-such-store', goal: 'shop', ceiling_rupees: 100 },
    })
    expect(result.isError).toBe(true)
  })
})
