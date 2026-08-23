/**
 * Ed25519 keypair + signing for "the human" identity the dashboard holds.
 *
 * This is the DEFAULT human signer — a raw keypair generated and stored by
 * the page itself, so the console can act as its own trust root with zero
 * setup. The private key lives in the page's JS heap for as long as the tab
 * is open. `webauthn.ts` + `human-signer.ts` provide an opt-in alternative
 * (a platform passkey) where the private key never leaves the authenticator
 * — strictly stronger, but it requires hardware and a registration step, so
 * this path stays the default. The signing math mirrors core's
 * verifyEd25519 exactly (sha256 digest, then raw Ed25519 over the digest) —
 * see packages/core/src/signature.ts — because core's verifier is the sole
 * judge of whether a signature this module produces is valid.
 */

import type { SigEnvelope } from '@hundi/core'
import * as ed25519 from '@noble/ed25519'
import { sha256, sha512 } from '@noble/hashes/sha2.js'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'

// @noble/ed25519 v3 ships hash-agnostic; sync sign/verify require the sync
// SHA-512 implementation injected once before first use.
ed25519.hashes.sha512 = sha512

export type HumanKeypair = {
  secretKeyHex: string
  publicKeyHex: string
}

/** Generates a fresh Ed25519 identity. Pure — no storage side effects. */
export function generateKeypair(): HumanKeypair {
  const { secretKey, publicKey } = ed25519.keygen()
  return { secretKeyHex: bytesToHex(secretKey), publicKeyHex: bytesToHex(publicKey) }
}

/** Signs `payloadBytes` with `secretKeyHex`, producing the ed25519 SigEnvelope
 * shape core.verifyMandateSignature expects. Pure — no storage side effects. */
export function signBytes(
  secretKeyHex: string,
  payloadBytes: Uint8Array,
): Extract<SigEnvelope, { type: 'ed25519' }> {
  const digest = sha256(payloadBytes)
  const signature = ed25519.sign(digest, hexToBytes(secretKeyHex))
  return { type: 'ed25519', signature_hex: bytesToHex(signature) }
}

const HUMAN_KEY_STORAGE_KEY = 'hundi.humanKey'

/** Loads the human keypair from localStorage, generating and persisting one on
 * first run. This IS the human's identity for the demo session — regenerating
 * it invalidates every mandate signed under the old key (approvals/revokes for
 * those mandates will fail signature verification against the facilitator's
 * registered credential). */
export function loadOrCreateHumanKeypair(): HumanKeypair {
  const raw = localStorage.getItem(HUMAN_KEY_STORAGE_KEY)
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as HumanKeypair
      if (parsed.secretKeyHex && parsed.publicKeyHex) return parsed
    } catch {
      // fall through to regeneration below — corrupt storage is not a crash
    }
  }
  const fresh = generateKeypair()
  localStorage.setItem(HUMAN_KEY_STORAGE_KEY, JSON.stringify(fresh))
  return fresh
}

/** Discards the stored human identity and creates a new one. */
export function resetHumanKeypair(): HumanKeypair {
  const fresh = generateKeypair()
  localStorage.setItem(HUMAN_KEY_STORAGE_KEY, JSON.stringify(fresh))
  return fresh
}
