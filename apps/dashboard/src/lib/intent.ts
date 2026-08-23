/**
 * Builds and signs the mandate-chain payloads the human console originates:
 * the intent mandate itself (the ceremony), an approval/rejection decision,
 * and a revocation. All three are signed with the human keypair — the human is
 * the mandate's registered credential (see mandates.ts / approvals.ts /
 * revoke.ts in the facilitator).
 *
 * The intent also declares an `agent_pubkey_hex`: a DISTINCT key, held by the
 * buyer agent, which signs carts (and only carts). The human never holds it and
 * the agent never holds the human key — so the agent can propose spending but
 * cannot approve or revoke it. That two-party split is the whole trust boundary;
 * the human signs the intent (attesting the agent key), the agent signs carts,
 * and above-threshold spending routes back to the human key for a decision.
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
  /** The buyer agent's ed25519 public key (hex). Generated out-of-band by the
   * agent and pasted into the ceremony; this is the key the intent attests as
   * the cart signer. Must NOT equal the human key. */
  agentPubkeyHex: string
}

export type SignedCeremony = {
  intent: IntentMandate
  credential: Credential
}

/** Builds a fresh IntentMandate from ceremony form input and signs it with the
 * human key. The intent embeds `input.agentPubkeyHex` as the attested cart
 * signer; the registered credential is the human key. Returns both the signed
 * intent and that credential (POST /mandates body shape). */
export function buildSignedIntent(input: CeremonyInput, human: HumanKeypair): SignedCeremony {
  const unsigned = {
    mandateId: crypto.randomUUID(),
    goal: input.goal,
    ceiling_paise: input.ceilingPaise,
    approval_threshold_paise: input.approvalThresholdPaise,
    currency: 'INR' as const,
    merchants: input.merchants,
    expires_at: input.expiresAt,
    agent_pubkey_hex: input.agentPubkeyHex,
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
