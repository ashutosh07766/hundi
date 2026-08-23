/**
 * Orchestrates the one-tap approval of a mandate proposal: builds the IntentMandate
 * from the proposal's already-paise terms and its own agent_pubkey_hex, signs it as
 * the human, mints a ceremony token, registers the real mandate through the EXISTING
 * POST /mandates flow (routes/mandates.ts on the facilitator — not a second
 * registration path), and marks the proposal consumed. The human's signature here —
 * whichever signer `sign` dispatches to (passkey or local key) — is the only step in
 * this sequence that creates spending authority; everything before and after it is
 * bookkeeping.
 */

import type { Credential } from '@hundi/core'
import type { MandateProposal } from './api.js'
import { consumeMandateProposal, mintCeremonyToken, registerMandate } from './api.js'
import type { HumanSign } from './intent.js'
import { buildSignedIntent, ceremonyInputFromProposal } from './intent.js'

export type ApproveMandateProposalArgs = {
  proposal: MandateProposal
  sign: HumanSign
  credential: Credential
  dashboardToken: string
}

export type ApproveMandateProposalResult = {
  mandateId: string
  intentHashHex: string
}

export async function approveMandateProposal(
  args: ApproveMandateProposalArgs,
): Promise<ApproveMandateProposalResult> {
  const ceremony = await buildSignedIntent(
    ceremonyInputFromProposal(args.proposal),
    args.sign,
    args.credential,
  )
  const ceremonyToken = await mintCeremonyToken(args.dashboardToken)
  const { mandateId, intent_hash_hex } = await registerMandate(
    ceremony.intent,
    ceremony.credential,
    ceremonyToken,
  )
  await consumeMandateProposal(args.proposal.id, args.dashboardToken)
  return { mandateId, intentHashHex: intent_hash_hex }
}
