/**
 * Proof: a mandate is a cumulative wallet, not a single-use allowance. Two
 * purchases under one mandate both capture, remaining_paise decreases across
 * them, and a purchase that would exceed the remaining budget is rejected
 * AMOUNT_EXCEEDS_CEILING (not ALLOWANCE_CONSUMED). Uses the same modules the
 * MCP tools use, against the live facilitator.
 *
 *   tsx --env-file=../../.env bin/prove-wallet.ts
 */
import { HttpBuyerTools, buildCartDraft } from '../src/agent-tools.ts'
import type { Product } from '../src/agent-tools.ts'
import { registerMandate } from '../src/session.ts'

const FAC = process.env.FACILITATOR_URL ?? 'http://127.0.0.1:8790'
const TOKEN = process.env.DASHBOARD_TOKEN ?? ''
const MERCHANT = 'myfrido-com'

async function remaining(mandateId: string): Promise<{ remaining: number; state: string }> {
  const body = (await (await fetch(`${FAC}/mandates`)).json()) as {
    mandates: { mandate_id: string; remaining_paise: number; state: string }[]
  }
  const m = body.mandates.find((x) => x.mandate_id === mandateId)
  if (!m) throw new Error('mandate not found in /mandates')
  return { remaining: m.remaining_paise, state: m.state }
}

async function main() {
  const catalog = (await (await fetch(`${FAC}/catalog/${MERCHANT}`)).json()) as Product[]
  const sneaker = catalog.find((p) => /active casual sneakers.*leather.*men/i.test(p.title))
  if (!sneaker?.variants) throw new Error('sneaker not found')
  const v11 = sneaker.variants.find((v) => /11uk/i.test(v.label) && v.available)
  const v10 = sneaker.variants.find((v) => /10uk/i.test(v.label) && v.available)
  if (!v11 || !v10) throw new Error('need two in-stock sizes')

  // Ceiling ₹12,000 comfortably fits two ₹4,499 pairs (₹8,998) but not three.
  const m = await registerMandate({
    facilitatorUrl: FAC,
    dashboardToken: TOKEN,
    goal: 'buy two pairs of Frido sneakers under one wallet',
    ceiling_paise: 1_200_000,
    approval_threshold_paise: 1_200_000,
    merchants: [MERCHANT],
    expires_at: Math.floor(Date.now() / 1000) + 3600,
  })
  console.log(`mandate ${m.mandateId}  ceiling ₹12000`)
  console.log('start:', await remaining(m.mandateId))

  const tools = new HttpBuyerTools({
    storeUrl: 'http://127.0.0.1:9/unused',
    facilitatorUrl: FAC,
    pollTimeoutMs: 180_000,
    pollIntervalMs: 2_000,
  })

  for (const v of [v11, v10]) {
    const cart = buildCartDraft([{ product: sneaker, qty: 1, variantId: v.variant_id }])
    const r = await tools.requestPayment({ intent: m.intent, cart, agent: m.agentKeyPair })
    console.log(`buy ${v.label}: ${r.state}${r.reason ? ` (${r.reason})` : ''}  →`, await remaining(m.mandateId))
  }

  // Third pair would push cumulative spend past the ceiling → must be rejected
  // for budget, and the mandate is NOT single-use-consumed.
  const cart3 = buildCartDraft([{ product: sneaker, qty: 1, variantId: v11.variant_id }])
  const r3 = await tools.requestPayment({ intent: m.intent, cart: cart3, agent: m.agentKeyPair })
  console.log(`buy 3rd pair: ${r3.state}${r3.reason ? ` (${r3.reason})` : ''}  →`, await remaining(m.mandateId))
}

main().catch((e) => {
  console.error('FAILED:', e instanceof Error ? e.message : e)
  process.exit(1)
})
