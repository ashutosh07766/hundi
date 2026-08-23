/**
 * Proof: a variant (size/color) purchase flows through the full stack —
 * buildCartDraft with a variant_id, agent-signed cart, facilitator verify, and
 * Razorpay TEST-mode capture — with the chosen variant cryptographically bound
 * in the signed cart. Uses the same modules the MCP request_purchase tool uses,
 * so it reproduces (or rules out) the SIG_INVALID_CART the MCP path hit.
 *
 *   tsx --env-file=../../.env bin/prove-variant-purchase.ts
 */

import type { Product } from '../src/agent-tools.ts'
import { buildCartDraft, HttpBuyerTools } from '../src/agent-tools.ts'
import { registerMandate } from '../src/session.ts'

const FAC = process.env.FACILITATOR_URL ?? 'http://127.0.0.1:8790'
const TOKEN = process.env.DASHBOARD_TOKEN ?? ''
const MERCHANT = 'myfrido-com'

async function main() {
  const catalog = (await (await fetch(`${FAC}/catalog/${MERCHANT}`)).json()) as Product[]
  const sneaker = catalog.find((p) => /active casual sneakers.*leather.*men/i.test(p.title))
  if (!sneaker) throw new Error('sneaker not found in catalog')
  const variant = sneaker.variants?.find((v) => /leather black \/ 11uk/i.test(v.label))
  if (!variant) throw new Error('11UK Leather Black variant not found')
  console.log(
    `product: ${sneaker.title}\nvariant: ${variant.label}  id=${variant.variant_id}  ₹${variant.price_paise / 100}  ${variant.available ? 'in stock' : 'OOS'}`,
  )

  const m = await registerMandate({
    facilitatorUrl: FAC,
    dashboardToken: TOKEN,
    goal: 'buy the Frido Active Casual Sneakers in Leather Black, size 11UK',
    ceiling_paise: 500_000,
    approval_threshold_paise: 500_000, // hands-free within the ceiling
    merchants: [MERCHANT],
    expires_at: Math.floor(Date.now() / 1000) + 3600,
  })
  console.log(`mandate: ${m.mandateId}  agent=${m.agentKeyPair.publicKeyHex.slice(0, 16)}…`)

  const cart = buildCartDraft([{ product: sneaker, qty: 1, variantId: variant.variant_id }])
  console.log(`cart total: ₹${cart.total_paise / 100}  items:`, JSON.stringify(cart.items))

  const tools = new HttpBuyerTools({
    storeUrl: 'http://127.0.0.1:9/unused',
    facilitatorUrl: FAC,
    pollTimeoutMs: 180_000,
    pollIntervalMs: 2_000,
  })
  const result = await tools.requestPayment({ intent: m.intent, cart, agent: m.agentKeyPair })
  console.log('\nRESULT:', JSON.stringify(result, null, 2))

  if (result.state === 'captured' && result.settlement_id) {
    const s = (await (await fetch(`${FAC}/settlements/${result.settlement_id}`)).json()) as {
      settlement?: { cart_json?: string }
      attempts?: { state: string; providerPaymentId?: string | null }[]
      ledger?: { event_type: string }[]
    }
    const pay = s.attempts?.find((a) => a.state === 'captured')?.providerPaymentId
    const signedCart = s.settlement?.cart_json ? JSON.parse(s.settlement.cart_json) : null
    console.log(`\n✅ CAPTURED  payment_id=${pay}`)
    console.log(`   signed cart variant_id: ${signedCart?.items?.[0]?.variant_id ?? '(none)'}`)
    console.log(
      `   signed cart variant_label: ${signedCart?.items?.[0]?.variant_label ?? '(none)'}`,
    )
  }
}

main().catch((e) => {
  console.error('FAILED:', e instanceof Error ? e.message : e)
  process.exit(1)
})
