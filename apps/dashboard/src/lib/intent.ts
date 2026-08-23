/**
 * Builds and signs the mandate-chain payloads the human console originates:
 * the intent mandate itself (the ceremony), an approval/rejection decision,
 * and a revocation. All three are signed with the same human keypair — the
 * dashboard-issued ceremony path makes the human both the intent's declared
 * agent and the mandate's registered credential (see mandates.ts /
 * approvals.ts / revoke.ts in the facilitator), so one key signs the whole
 * lifecycle for a mandate this console minted.
 */

import type { Credential, IntentMandate, SigEnvelope } from '@hundi/core'
import { canonicalJson, intentSigningBytes } from '@hundi/core'
import type { HumanKeypair } from './signing.js'
import { signBytes } from './signing.js'

export type CeremonyInput = {
  goal: string
  ceilingPaise: number
  approvalThresholdPaise: number
  merchants: string[]
  expiresAt: number
}

export type SignedCeremony = {
  intent: IntentMandate
  credential: Credential
}

/** Builds a fresh IntentMandate from ceremony form input and signs it with the
 * human key. Returns both the signed intent and the credential the facilitator
 * should bind it to (POST /mandates body shape). */
export function buildSignedIntent(input: CeremonyInput, human: HumanKeypair): SignedCeremony {
  const unsigned = {
    mandateId: crypto.randomUUID(),
    goal: input.goal,
    ceiling_paise: input.ceilingPaise,
    approval_threshold_paise: input.approvalThresholdPaise,
    currency: 'INR' as const,
    merchants: input.merchants,
    expires_at: input.expiresAt,
    agent_pubkey_hex: human.publicKeyHex,
  }
  const sig = signBytes(human.secretKeyHex, intentSigningBytes(unsigned))
  return {
    intent: { ...unsigned, sig },
    credential: { type: 'ed25519', publicKey_hex: human.publicKeyHex },
  }
}

/** Signs an approval/rejection decision — POST /approvals verifies this against the
 * mandate's registered credential, so the payload shape must match exactly what
 * approvals.ts recomputes: `{ settlement_id, mandate_cart_hash_hex, decision }`. */
export function signApprovalDecision(
  args: { settlementId: string; mandateCartHashHex: string; decision: 'approved' | 'rejected' },
  human: HumanKeypair,
): Extract<SigEnvelope, { type: 'ed25519' }> {
  const bytes = canonicalJson({
    settlement_id: args.settlementId,
    mandate_cart_hash_hex: args.mandateCartHashHex,
    decision: args.decision,
  })
  return signBytes(human.secretKeyHex, bytes)
}

/** Signs a revocation — POST /revoke verifies this against `{ mandateId, action: 'revoke' }`,
 * per revoke.ts. */
export function signRevoke(
  mandateId: string,
  human: HumanKeypair,
): Extract<SigEnvelope, { type: 'ed25519' }> {
  const bytes = canonicalJson({ mandateId, action: 'revoke' })
  return signBytes(human.secretKeyHex, bytes)
}
