/**
 * Ed25519 keypair generation and signing via node:crypto — no extra dependency,
 * and the same primitive the facilitator's own HTTP tests sign with (see
 * packages/facilitator/src/__tests__/http-helpers.ts). Kept as its own module so
 * agent-tools.ts and session.ts share one signing implementation instead of two
 * copies that could silently drift out of sync with each other.
 */

import crypto from 'node:crypto'
import type { SigEnvelope } from '@hundi/core'

export type AgentKeypair = { privateKey: crypto.KeyObject; publicKeyHex: string }

function base64UrlToHex(b64url: string): string {
  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/')
  return Buffer.from(b64, 'base64').toString('hex')
}

/** Generates a fresh agent identity. The public key is exposed as raw hex — the
 * shape `IntentMandate.agent_pubkey_hex` and `Credential.publicKey_hex` expect. */
export function generateAgentKeypair(): AgentKeypair {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519')
  const jwk = publicKey.export({ format: 'jwk' }) as { x: string }
  return { privateKey, publicKeyHex: base64UrlToHex(jwk.x) }
}

/** Mirrors core's verifyEd25519 exactly: sign SHA-256(payloadBytes) with raw Ed25519.
 * The two halves of one contract — drift here means every signature this module
 * produces fails core's verifyMandateSignature. */
export function signPayload(
  privateKey: crypto.KeyObject,
  payloadBytes: Uint8Array,
): Extract<SigEnvelope, { type: 'ed25519' }> {
  const digest = crypto.createHash('sha256').update(payloadBytes).digest()
  const signature = crypto.sign(null, digest, privateKey)
  return { type: 'ed25519', signature_hex: signature.toString('hex') }
}
