import { afterEach, describe, expect, it } from 'vitest'
import { generateAgentKeypair } from '../../../../agents/scripted-brain/src/ed25519.js'
import { createFacilitatorClient } from '../facilitator-client.js'
import { formatRupees } from '../format.js'
import { createHundiMcpServer } from '../server.js'
import { fakeFacilitatorFetch, makeFakeFacilitatorState } from './fake-facilitator.js'
import { makeSignedIntent, mandateRow } from './fixtures.js'
import { connectedClient, jsonOf } from './mcp-client.js'

const FACILITATOR_URL = 'http://fake-facilitator.test'

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})

function buildServer(state: ReturnType<typeof makeFakeFacilitatorState>) {
  globalThis.fetch = fakeFacilitatorFetch(state)
  const facilitatorClient = createFacilitatorClient(FACILITATOR_URL)
  const server = createHundiMcpServer({
    agent: generateAgentKeypair(),
    facilitatorUrl: FACILITATOR_URL,
    facilitatorClient,
  })
  return server
}

type ExplanationBody = {
  timeline: { event: string; actor: string; at: number }[]
  explanation: {
    authorized_by: {
      mandate_id: string
      goal: string
      ceiling_paise: number
      ceiling_display: string
      constraints: string[]
    } | null
    explanation_note?: string
    checks_passed: string[] | null
    fresh_price: string | null
    payment: { razorpay_payment_id: string | null; amount_paise: number; amount_display: string }
    ledger_timeline: { event: string; actor: string; at: number }[]
  }
}

describe('get_order — explanation audit view', () => {
  it('resolves the authorizing mandate and enumerates the gate checks that passed', async () => {
    const agent = generateAgentKeypair()
    const { intent } = makeSignedIntent({
      agent,
      overrides: {
        mandateId: 'mandate-audit-1',
        goal: 'buy running shoes',
        ceiling_paise: 500_000,
        approval_threshold_paise: 200_000,
        merchants: ['demo-store-1'],
        per_merchant_ceiling_paise: { 'demo-store-1': 300_000 },
        allowed_skus: ['sku-001', 'sku-002'],
      },
    })

    const state = makeFakeFacilitatorState({
      mandates: [mandateRow({ mandateId: intent.mandateId, intent })],
      settlementsById: {
        'settlement-audit-1': {
          ok: true,
          settlement: {
            id: 'settlement-audit-1',
            mandate_id: intent.mandateId,
            state: 'captured',
            amount_paise: 300_000,
            merchant_id: 'demo-store-1',
            cart_json: JSON.stringify({
              cartId: 'c1',
              merchant_id: 'demo-store-1',
              items: [{ sku: 'sku-001', qty: 1, unit_price_paise: 300_000 }],
              total_paise: 300_000,
              intent_hash_hex: 'a'.repeat(64),
              agent_sig_hex: 'b'.repeat(128),
            }),
            reject_reason: null,
            created_at: 1,
          },
          attempts: [
            { state: 'captured', provider_payment_id: 'pay_audit_1', receipt: 'r1', created_at: 2 },
          ],
          ledger: [
            { event_type: 'verify_passed', actor: 'facilitator', created_at: 2 },
            { event_type: 'payment_captured', actor: 'executor', created_at: 3 },
          ],
        },
      },
    })
    const server = buildServer(state)
    const client = await connectedClient(server)

    const result = await client.callTool({
      name: 'get_order',
      arguments: { settlement_id: 'settlement-audit-1' },
    })
    expect(result.isError).toBeFalsy()
    const body = jsonOf<ExplanationBody>(result)

    expect(body.explanation.authorized_by).toEqual({
      mandate_id: 'mandate-audit-1',
      goal: 'buy running shoes',
      ceiling_paise: 500_000,
      ceiling_display: formatRupees(500_000),
      constraints: [
        `requires human approval for any single cart over ${formatRupees(200_000)}`,
        `per-merchant ceiling of ${formatRupees(300_000)} at demo-store-1`,
        'restricted to 2 specific products',
      ],
    })
    expect(body.explanation.explanation_note).toBeUndefined()

    expect(body.explanation.checks_passed).not.toBeNull()
    const checks = body.explanation.checks_passed ?? []
    expect(checks).toContain(
      `spend at demo-store-1 stayed within its ${formatRupees(300_000)} per-merchant ceiling`,
    )
    expect(checks).toContain("the purchased sku is within the mandate's authorized product set")
    expect(checks).toContain(
      "the human's mandate signature and the agent's cart signature both verified",
    )

    expect(body.explanation.fresh_price).toContain('demo-store-1')
    expect(body.explanation.fresh_price).toContain(formatRupees(300_000))

    expect(body.explanation.payment).toEqual({
      razorpay_payment_id: 'pay_audit_1',
      amount_paise: 300_000,
      amount_display: formatRupees(300_000),
    })

    expect(body.explanation.ledger_timeline).toEqual(body.timeline)
  })

  it('degrades visibly instead of throwing when the authorizing mandate cannot be found', async () => {
    const state = makeFakeFacilitatorState({
      // No mandates on record at all — the settlement references a mandate id
      // that listMandates() will never return.
      mandates: [],
      settlementsById: {
        'settlement-orphan-1': {
          ok: true,
          settlement: {
            id: 'settlement-orphan-1',
            mandate_id: 'mandate-missing',
            state: 'captured',
            amount_paise: 150_000,
            merchant_id: 'demo-store-1',
            cart_json: JSON.stringify({
              cartId: 'c2',
              merchant_id: 'demo-store-1',
              items: [{ sku: 'sku-003', qty: 1, unit_price_paise: 150_000 }],
              total_paise: 150_000,
              intent_hash_hex: 'c'.repeat(64),
              agent_sig_hex: 'd'.repeat(128),
            }),
            reject_reason: null,
            created_at: 1,
          },
          attempts: [
            {
              state: 'captured',
              provider_payment_id: 'pay_orphan_1',
              receipt: 'r2',
              created_at: 2,
            },
          ],
          ledger: [{ event_type: 'verify_passed', actor: 'facilitator', created_at: 2 }],
        },
      },
    })
    const server = buildServer(state)
    const client = await connectedClient(server)

    const result = await client.callTool({
      name: 'get_order',
      arguments: { settlement_id: 'settlement-orphan-1' },
    })
    expect(result.isError).toBeFalsy()
    const body = jsonOf<ExplanationBody>(result)

    expect(body.explanation.authorized_by).toBeNull()
    expect(body.explanation.explanation_note).toContain('mandate-missing')

    // The gate-guarantee checks that don't depend on the mandate's specific
    // policy fields still surface — only the mandate-derived facts go missing.
    expect(body.explanation.checks_passed).not.toBeNull()
    expect(body.explanation.checks_passed ?? []).toContain(
      "the merchant is within the mandate's authorized scope",
    )
  })

  it('reports no gate checks passed for a settlement still awaiting human approval', async () => {
    const agent = generateAgentKeypair()
    const { intent } = makeSignedIntent({
      agent,
      overrides: { mandateId: 'mandate-pending-1', merchants: ['demo-store-1'] },
    })

    const state = makeFakeFacilitatorState({
      mandates: [mandateRow({ mandateId: intent.mandateId, intent })],
      settlementsById: {
        'settlement-pending-1': {
          ok: true,
          settlement: {
            id: 'settlement-pending-1',
            mandate_id: intent.mandateId,
            state: 'pending_approval',
            amount_paise: 250_000,
            merchant_id: 'demo-store-1',
            cart_json: JSON.stringify({
              cartId: 'c3',
              merchant_id: 'demo-store-1',
              items: [{ sku: 'sku-004', qty: 1, unit_price_paise: 250_000 }],
              total_paise: 250_000,
              intent_hash_hex: 'e'.repeat(64),
              agent_sig_hex: 'f'.repeat(128),
            }),
            reject_reason: null,
            created_at: 1,
          },
          attempts: [],
          ledger: [{ event_type: 'approval_requested', actor: 'facilitator', created_at: 2 }],
        },
      },
    })
    const server = buildServer(state)
    const client = await connectedClient(server)

    const result = await client.callTool({
      name: 'get_order',
      arguments: { settlement_id: 'settlement-pending-1' },
    })
    expect(result.isError).toBeFalsy()
    const body = jsonOf<ExplanationBody>(result)

    // The mandate resolves fine — approval_requested just hasn't cleared the
    // gate-passed bar yet (that's verify_passed or approval_granted).
    expect(body.explanation.authorized_by?.mandate_id).toBe('mandate-pending-1')
    expect(body.explanation.checks_passed).toBeNull()
    expect(body.explanation.fresh_price).toBeNull()
  })
})
