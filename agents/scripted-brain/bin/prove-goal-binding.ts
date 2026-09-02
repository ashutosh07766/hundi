/**
 * Proof: intent-binding via a SIGNED sku allow-set. A mandate pinned to the
 * sneaker's sku accepts the sneaker but REJECTS off-goal items (Foot Alignment
 * Socks) with GOAL_MISMATCH — pure set membership between two signed sets, so the
 * merchant can't expand what was authorized by editing catalog text. Uses the
 * stateless /verify dry-run so nothing is captured.
 *
 *   tsx --env-file=../../.env bin/prove-goal-binding.ts
 */
import { randomUUID } from 'node:crypto'
import { cartSigningBytes, intentSigningBytes, sha256Hex } from '@hundi/core'
import type { CartMandate, IntentMandate } from '@hundi/core'
import { buildCartDraft } from '../src/agent-tools.ts'
import type { AgentKeypair, Product } from '../src/agent-tools.ts'
import { signPayload } from '../src/ed25519.ts'
import { registerMandate } from '../src/session.ts'

const FAC = process.env.FACILITATOR_URL ?? 'http://127.0.0.1:8790'
const TOKEN = process.env.DASHBOARD_TOKEN ?? ''
const MERCHANT = 'myfrido-com'

function signCart(
  draft: { merchant_id: string; items: CartMandate['items']; total_paise: number },
  intent: IntentMandate,
  agent: AgentKeypair,
): CartMandate {
  const unsigned = {
    cartId: randomUUID(),
    merchant_id: draft.merchant_id,
    items: draft.items,
    total_paise: draft.total_paise,
    intent_hash_hex: sha256Hex(intentSigningBytes(intent)),
  }
  return { ...unsigned, agent_sig_hex: signPayload(agent.privateKey, cartSigningBytes(unsigned)).signature_hex }
}

async function verify(intent: IntentMandate, cart: CartMandate): Promise<string> {
  const res = await fetch(`${FAC}/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ intent, cart }),
  })
  const body = (await res.json()) as { ok: boolean; reason?: string; needsApproval?: boolean }
  return body.ok ? `ACCEPTED${body.needsApproval ? ' (needs approval)' : ''}` : `REJECTED ${body.reason}`
}

async function main() {
  const catalog = (await (await fetch(`${FAC}/catalog/${MERCHANT}`)).json()) as Product[]
  const shoe = catalog.find((p) => /active casual sneakers.*leather.*men/i.test(p.title))
  const socks = catalog.find((p) => /foot alignment socks/i.test(p.title))
  if (!shoe || !socks) throw new Error('need both a sneaker and the socks in the catalog')

  const m = await registerMandate({
    facilitatorUrl: FAC,
    dashboardToken: TOKEN,
    goal: 'buy running shoes only',
    ceiling_paise: 5_000_000,
    approval_threshold_paise: 5_000_000,
    merchants: [MERCHANT],
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    allowed_skus: [shoe.id],
  })
  console.log(`mandate ${m.mandateId}  allowed_skus=[${shoe.id}]\n`)

  const shoeCart = signCart(buildCartDraft([{ product: shoe, qty: 1 }]), m.intent, m.agentKeyPair)
  const sockCart = signCart(buildCartDraft([{ product: socks, qty: 1 }]), m.intent, m.agentKeyPair)

  console.log(`"${shoe.title.slice(0, 40)}"  →  ${await verify(m.intent, shoeCart)}`)
  console.log(`"${socks.title}"  →  ${await verify(m.intent, sockCart)}`)
}

main().catch((e) => {
  console.error('FAILED:', e instanceof Error ? e.message : e)
  process.exit(1)
})
