/**
 * Mandate registration for the demo/test harness — the scripted-issuance path:
 * mint a ceremony token with the dashboard token, then register a human-signed
 * IntentMandate against it. This stands in for the passkey ceremony a human would
 * otherwise perform in the dashboard; nothing here reaches a code path a caller
 * without the dashboard token could also reach.
 *
 * Two distinct keys, two distinct parties (matching docs/rfc.md and the core
 * verify gate): the HUMAN key signs the intent and is registered as the mandate's
 * credential — it later signs approvals and revocations. The AGENT key is embedded
 * in the human-signed intent as `agent_pubkey_hex` (so the human attests it) and
 * signs carts and decision narration, nothing else. Callers get both keypairs
 * back: the agent key to sign carts, the human key to approve/revoke.
 */

import { randomUUID } from 'node:crypto'
import type { IntentMandate } from '@hundi/core'
import { intentSigningBytes } from '@hundi/core'
import type { AgentKeypair } from './ed25519.js'
import { generateAgentKeypair, signPayload } from './ed25519.js'

export type RegisterMandateArgs = {
  facilitatorUrl: string
  dashboardToken: string
  goal: string
  ceiling_paise: number
  approval_threshold_paise: number
  merchants: string[]
  /** Unix seconds. */
  expires_at: number
  /** Reuses an existing agent identity (the cart signer) instead of minting a
   * fresh one — mostly for tests that need to assert against a known public key. */
  agent?: AgentKeypair
  /** Reuses an existing human identity (the intent/approval/revoke signer)
   * instead of minting a fresh one. */
  human?: AgentKeypair
  /** Optional signed spending policy — carried into the intent (and thus the
   * human's signature) only when set, matching intentSigningBytes' byte-compat
   * convention. */
  per_merchant_ceiling_paise?: Record<string, number>
  cumulative_approval_threshold_paise?: number
  allowed_skus?: string[]
}

export type RegisteredMandate = {
  mandateId: string
  intent: IntentMandate
  /** Signs carts and decision narration. Embedded as `intent.agent_pubkey_hex`. */
  agentKeyPair: AgentKeypair
  /** The registered credential — signs the intent, approvals, and revocations. */
  humanKeyPair: AgentKeypair
}

/** Runs the full ceremony (mint token, human-sign intent, register the human
 * credential) and returns the registered mandate plus both keypairs — the agent
 * key that authorizes carts and the human key that authorizes approvals/revokes. */
export async function registerMandate(args: RegisterMandateArgs): Promise<RegisteredMandate> {
  const base = args.facilitatorUrl.replace(/\/$/, '')
  const agent = args.agent ?? generateAgentKeypair()
  const human = args.human ?? generateAgentKeypair()

  const tokenRes = await fetch(`${base}/ceremony-tokens`, {
    method: 'POST',
    headers: { 'x-hundi-dashboard-token': args.dashboardToken },
  })
  if (!tokenRes.ok) {
    throw new Error(`registerMandate: ceremony-token mint failed with ${tokenRes.status}`)
  }
  const { ceremonyToken } = (await tokenRes.json()) as { ceremonyToken: string }

  const unsigned: Omit<IntentMandate, 'sig'> = {
    mandateId: randomUUID(),
    goal: args.goal,
    ceiling_paise: args.ceiling_paise,
    approval_threshold_paise: args.approval_threshold_paise,
    currency: 'INR',
    merchants: args.merchants,
    expires_at: args.expires_at,
    agent_pubkey_hex: agent.publicKeyHex,
    ...(args.per_merchant_ceiling_paise
      ? { per_merchant_ceiling_paise: args.per_merchant_ceiling_paise }
      : {}),
    ...(args.cumulative_approval_threshold_paise !== undefined
      ? { cumulative_approval_threshold_paise: args.cumulative_approval_threshold_paise }
      : {}),
    ...(args.allowed_skus ? { allowed_skus: args.allowed_skus } : {}),
  }
  const sig = signPayload(human.privateKey, intentSigningBytes(unsigned))
  const intent: IntentMandate = { ...unsigned, sig }

  const registerRes = await fetch(`${base}/mandates`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      intent,
      credential: { type: 'ed25519', publicKey_hex: human.publicKeyHex },
      ceremonyToken,
    }),
  })
  const body = (await registerRes.json()) as
    | { ok: true; mandateId: string; intent_hash_hex: string }
    | { ok: false; error: string }
  if (!body.ok) throw new Error(`registerMandate: mandate registration failed: ${body.error}`)

  return { mandateId: body.mandateId, intent, agentKeyPair: agent, humanKeyPair: human }
}
