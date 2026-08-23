/**
 * Builds the mandate-chain payloads the human console originates: the intent
 * mandate itself (the ceremony), an approval/rejection decision, and a
 * revocation. All three are signed via an injected `sign` function — see
 * `human-signer.ts` — so this module stays agnostic to which identity is
 * doing the signing (Ed25519 keypair or WebAuthn passkey); it only knows the
 * exact bytes each payload type must sign over.
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

/** Signs arbitrary payload bytes as the human — see `human-signer.ts`'s `humanSign`,
 * partially applied to the currently active identity. */
export type HumanSign = (payloadBytes: Uint8Array) => Promise<SigEnvelope>

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

/** Builds a fresh IntentMandate from ceremony form input and signs it with `sign`.
 * The intent embeds `input.agentPubkeyHex` as the attested cart signer; `credential`
 * is whatever the active human identity resolves to (POST /mandates body shape) —
 * it must be the credential `sign` actually signs with, or the facilitator's
 * signature check on registration will reject the mandate. */
export async function buildSignedIntent(
  input: CeremonyInput,
  sign: HumanSign,
  credential: Credential,
): Promise<SignedCeremony> {
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
  const sig = await sign(intentSigningBytes(unsigned))
  return { intent: { ...unsigned, sig }, credential }
}

/** The subset of a facilitator mandate proposal (GET /mandates/proposals/:id) needed to
 * build its intent — kept narrow so this module doesn't import the full `lib/api.ts`
 * `MandateProposal` type, avoiding a dependency cycle between the two. */
export type MandateProposalForIntent = {
  goal: string
  ceiling_paise: number
  approval_threshold_paise: number
  merchant_id: string
  agent_pubkey_hex: string
  expires_at: number
}

/** Maps a facilitator mandate proposal directly onto `buildSignedIntent`'s paise-
 * denominated `CeremonyInput` — no rupee conversion happens here, because a proposal
 * (packages/facilitator's mandate_proposals table) already stores paise. Carries
 * `agent_pubkey_hex` straight from the proposal: unlike the manual ceremony's blank-
 * field fallback, a proposal always names a specific agent (the one that called
 * prepare_mandate) and this never mints a fresh key in its place. */
export function ceremonyInputFromProposal(proposal: MandateProposalForIntent): CeremonyInput {
  return {
    goal: proposal.goal,
    ceilingPaise: proposal.ceiling_paise,
    approvalThresholdPaise: proposal.approval_threshold_paise,
    merchants: [proposal.merchant_id],
    expiresAt: proposal.expires_at,
    agentPubkeyHex: proposal.agent_pubkey_hex,
  }
}

/** Signs an approval/rejection decision — POST /approvals verifies this against the
 * mandate's registered credential, so the payload shape must match exactly what
 * approvals.ts recomputes: `{ settlement_id, mandate_cart_hash_hex, decision }`. */
export async function signApprovalDecision(
  args: { settlementId: string; mandateCartHashHex: string; decision: 'approved' | 'rejected' },
  sign: HumanSign,
): Promise<SigEnvelope> {
  const bytes = canonicalJson({
    settlement_id: args.settlementId,
    mandate_cart_hash_hex: args.mandateCartHashHex,
    decision: args.decision,
  })
  return sign(bytes)
}

/** Signs a revocation — POST /revoke verifies this against `{ mandateId, action: 'revoke' }`,
 * per revoke.ts. */
export async function signRevoke(mandateId: string, sign: HumanSign): Promise<SigEnvelope> {
  const bytes = canonicalJson({ mandateId, action: 'revoke' })
  return sign(bytes)
}
