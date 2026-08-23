/**
 * Dispatches human signing to whichever identity is currently active: the
 * default Ed25519 keypair (private key lives in the page's JS heap — see
 * signing.ts) or a registered WebAuthn passkey (private key never leaves the
 * authenticator — see webauthn.ts). The mandate ceremony, approval
 * decisions, and revocations all sign through this single dispatch point,
 * so the two paths can't drift out of sync with each other or with which
 * credential got registered on the mandate.
 *
 * Kept free of React so the dispatch logic — not just its wiring into a
 * context provider — is directly unit-testable.
 */

import type { Credential, SigEnvelope } from '@hundi/core'
import type { HumanKeypair } from './signing.js'
import { signBytes } from './signing.js'
import type { PasskeyIdentity } from './webauthn.js'
import { signWithPasskey } from './webauthn.js'

export type SignerMode = 'ed25519' | 'passkey'

export type HumanIdentity = {
  mode: SignerMode
  ed25519: HumanKeypair
  /** Null until the operator completes the passkey ceremony at least once. */
  passkey: PasskeyIdentity | null
  /** WebAuthn RP id the passkey was (or would be) registered under — must match
   * at assertion time, so it travels with the identity rather than being
   * re-derived at each call site. */
  rpId: string
}

/** True only when passkey mode is selected AND a passkey has actually been
 * registered. `mode === 'passkey'` with no registered passkey is a UI state
 * that should never be reachable (selecting the toggle registers-or-fails
 * atomically — see identity-context.tsx) but this dispatcher treats it as
 * "not really active" rather than throwing, so a caller can't be surprised
 * by an exception from a getter. */
function isPasskeyActive(
  identity: HumanIdentity,
): identity is HumanIdentity & { passkey: PasskeyIdentity } {
  return identity.mode === 'passkey' && identity.passkey !== null
}

/** The credential a mandate ceremony should register for the currently active signer. */
export function resolveHumanCredential(identity: HumanIdentity): Credential {
  if (isPasskeyActive(identity)) {
    return { type: 'webauthn-es256', publicKey_jwk: identity.passkey.publicKey_jwk }
  }
  return { type: 'ed25519', publicKey_hex: identity.ed25519.publicKeyHex }
}

/** Signs `payloadBytes` as the human, dispatching on `identity.mode`. Ed25519
 * signing is synchronous math wrapped in a resolved promise; passkey signing
 * awaits a real browser ceremony (`navigator.credentials.get`). */
export async function humanSign(
  identity: HumanIdentity,
  payloadBytes: Uint8Array,
): Promise<SigEnvelope> {
  if (isPasskeyActive(identity)) {
    return signWithPasskey(payloadBytes, identity.passkey.credentialId, identity.rpId)
  }
  return signBytes(identity.ed25519.secretKeyHex, payloadBytes)
}
