/**
 * Mandate registration for the demo/test harness — the scripted-issuance path:
 * mint a ceremony token with the dashboard token, then register an agent-signed
 * IntentMandate against it. This stands in for the passkey ceremony a human would
 * otherwise perform in the dashboard; nothing here reaches a code path a caller
 * without the dashboard token could also reach.
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
  /** Reuses an existing identity instead of minting a fresh one — mostly for tests
   * that need to assert against a known public key. */
  agent?: AgentKeypair
}

export type RegisteredMandate = {
  mandateId: string
  intent: IntentMandate
  agentKeyPair: AgentKeypair
}

/** Runs the full ceremony (mint token, sign intent, register) and returns the
 * registered mandate plus the agent keypair that authorizes every subsequent
 * cart signed against it. */
export async function registerMandate(args: RegisterMandateArgs): Promise<RegisteredMandate> {
  const base = args.facilitatorUrl.replace(/\/$/, '')
  const agent = args.agent ?? generateAgentKeypair()

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
  }
  const sig = signPayload(agent.privateKey, intentSigningBytes(unsigned))
  const intent: IntentMandate = { ...unsigned, sig }

  const registerRes = await fetch(`${base}/mandates`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      intent,
      credential: { type: 'ed25519', publicKey_hex: agent.publicKeyHex },
      ceremonyToken,
    }),
  })
  const body = (await registerRes.json()) as
    | { ok: true; mandateId: string; intent_hash_hex: string }
    | { ok: false; error: string }
  if (!body.ok) throw new Error(`registerMandate: mandate registration failed: ${body.error}`)

  return { mandateId: body.mandateId, intent, agentKeyPair: agent }
}
