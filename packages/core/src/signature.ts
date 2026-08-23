/**
 * Signature verification for the two envelope types a mandate can carry.
 * The verifying key always comes from the caller's registered-credential
 * store (`credential` param) — never from the signed payload itself, or a
 * forged payload could smuggle in its own "trusted" key.
 */

import { p256 } from '@noble/curves/nist.js'
import * as ed25519 from '@noble/ed25519'
import { sha256, sha512 } from '@noble/hashes/sha2.js'
import { decodeBase64Url, sha256B64url } from './hash.js'
import type { SigEnvelope } from './mandate.js'

// noble-ed25519 v3 requires the sync SHA-512 implementation to be injected
// before any sync sign/verify call — it ships hash-agnostic by design.
ed25519.hashes.sha512 = sha512

export type Credential =
  | { type: 'ed25519'; publicKey_hex: string }
  | { type: 'webauthn-es256'; publicKey_jwk: JsonWebKey }

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error('hexToBytes: odd-length hex string')
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < bytes.length; i++) {
    const byte = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
    if (Number.isNaN(byte)) throw new Error('hexToBytes: invalid hex string')
    bytes[i] = byte
  }
  return bytes
}

/** Converts a P-256 JWK (base64url x/y coordinates) to a raw uncompressed SEC1 public key. */
function jwkToRawP256PublicKey(jwk: JsonWebKey): Uint8Array {
  if (jwk.kty !== 'EC' || jwk.crv !== 'P-256' || !jwk.x || !jwk.y) {
    throw new Error('jwkToRawP256PublicKey: expected an EC P-256 JWK with x and y')
  }
  const x = decodeBase64Url(jwk.x)
  const y = decodeBase64Url(jwk.y)
  if (x.length !== 32 || y.length !== 32) {
    throw new Error('jwkToRawP256PublicKey: x/y must each be 32 bytes')
  }
  const raw = new Uint8Array(65)
  raw[0] = 0x04
  raw.set(x, 1)
  raw.set(y, 33)
  return raw
}

function concatBytes(...chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, c) => sum + c.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out
}

function verifyEd25519(
  payloadBytes: Uint8Array,
  sig: Extract<SigEnvelope, { type: 'ed25519' }>,
  credential: Extract<Credential, { type: 'ed25519' }>,
): boolean {
  const message = sha256(payloadBytes)
  const signature = hexToBytes(sig.signature_hex)
  const publicKey = hexToBytes(credential.publicKey_hex)
  return ed25519.verify(signature, message, publicKey)
}

function verifyWebauthnEs256(
  payloadBytes: Uint8Array,
  sig: Extract<SigEnvelope, { type: 'webauthn-es256' }>,
  credential: Extract<Credential, { type: 'webauthn-es256' }>,
): boolean {
  const clientDataBytes = decodeBase64Url(sig.clientDataJSON_b64u)
  let clientData: { type?: unknown; challenge?: unknown }
  try {
    clientData = JSON.parse(new TextDecoder().decode(clientDataBytes))
  } catch {
    return false
  }
  if (clientData.type !== 'webauthn.get') return false
  if (clientData.challenge !== sha256B64url(payloadBytes)) return false

  const authenticatorData = decodeBase64Url(sig.authenticatorData_b64u)
  const signature = decodeBase64Url(sig.signature_b64u)
  const publicKey = jwkToRawP256PublicKey(credential.publicKey_jwk)

  // ES256 signs `authenticatorData || SHA-256(clientDataJSON)`, then ECDSA hashes that
  // concatenation with SHA-256 again as part of the signing operation (prehash: true below).
  const signedData = concatBytes(authenticatorData, sha256(clientDataBytes))
  // WebAuthn assertion signatures are DER-encoded; { format: 'der' } parses r/s from the DER
  // structure rather than requiring compact r||s bytes.
  return p256.verify(signature, signedData, publicKey, { format: 'der' })
}

/** Verifies `sig` over `payloadBytes` using the caller-supplied `credential`'s public key. */
export function verifyMandateSignature(
  payloadBytes: Uint8Array,
  sig: SigEnvelope,
  credential: Credential,
): boolean {
  if (sig.type === 'ed25519' && credential.type === 'ed25519') {
    return verifyEd25519(payloadBytes, sig, credential)
  }
  if (sig.type === 'webauthn-es256' && credential.type === 'webauthn-es256') {
    return verifyWebauthnEs256(payloadBytes, sig, credential)
  }
  return false
}
