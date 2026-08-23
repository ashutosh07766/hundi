import { p256 } from '@noble/curves/nist.js'
import * as ed25519 from '@noble/ed25519'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import { describe, expect, it } from 'vitest'
import { canonicalJson } from '../canonical-json.js'
import { sha256B64url } from '../hash.js'
import { verifyMandateSignature } from '../signature.js'
import '../signature.js' // registers ed25519's sync SHA-512 provider

function b64url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

describe('verifyMandateSignature — ed25519', () => {
  const payload = canonicalJson({ a: 1, b: 'x' })
  const { secretKey, publicKey } = ed25519.keygen(new Uint8Array(32).fill(9))
  const credential = { type: 'ed25519' as const, publicKey_hex: bytesToHex(publicKey) }

  it('verifies a genuine signature', () => {
    const signature = ed25519.sign(sha256(payload), secretKey)
    const sig = { type: 'ed25519' as const, signature_hex: bytesToHex(signature) }
    expect(verifyMandateSignature(payload, sig, credential)).toBe(true)
  })

  it('rejects a tampered payload', () => {
    const signature = ed25519.sign(sha256(payload), secretKey)
    const sig = { type: 'ed25519' as const, signature_hex: bytesToHex(signature) }
    const tampered = canonicalJson({ a: 2, b: 'x' })
    expect(verifyMandateSignature(tampered, sig, credential)).toBe(false)
  })

  it('rejects a signature from a different key', () => {
    const { secretKey: otherSecret } = ed25519.keygen(new Uint8Array(32).fill(3))
    const signature = ed25519.sign(sha256(payload), otherSecret)
    const sig = { type: 'ed25519' as const, signature_hex: bytesToHex(signature) }
    expect(verifyMandateSignature(payload, sig, credential)).toBe(false)
  })

  it('rejects when envelope and credential types mismatch', () => {
    const signature = ed25519.sign(sha256(payload), secretKey)
    const sig = { type: 'ed25519' as const, signature_hex: bytesToHex(signature) }
    const wrongCredential = { type: 'webauthn-es256' as const, publicKey_jwk: {} as JsonWebKey }
    expect(verifyMandateSignature(payload, sig, wrongCredential)).toBe(false)
  })
})

describe('verifyMandateSignature — webauthn-es256', () => {
  const payload = canonicalJson({ cartId: 'cart-1', total_paise: 100 })
  const secretKey = p256.utils.randomSecretKey()
  const publicKeyBytes = p256.getPublicKey(secretKey, false) // uncompressed: 0x04 || x || y
  const x = publicKeyBytes.slice(1, 33)
  const y = publicKeyBytes.slice(33, 65)
  const jwk: JsonWebKey = {
    kty: 'EC',
    crv: 'P-256',
    x: b64url(x),
    y: b64url(y),
  }
  const credential = { type: 'webauthn-es256' as const, publicKey_jwk: jwk }

  function buildAssertion(challengeSource: Uint8Array) {
    const clientData = JSON.stringify({
      type: 'webauthn.get',
      challenge: sha256B64url(challengeSource),
      origin: 'https://example.test',
    })
    const clientDataBytes = new TextEncoder().encode(clientData)
    // Minimal 37-byte authenticatorData: rpIdHash(32) || flags(1) || signCount(4).
    const authenticatorData = new Uint8Array(37)
    authenticatorData[32] = 0x05 // UP + UV flags set

    const signedData = new Uint8Array(authenticatorData.length + 32)
    signedData.set(authenticatorData, 0)
    signedData.set(sha256(clientDataBytes), authenticatorData.length)

    const signature = p256.sign(signedData, secretKey, { format: 'der' })

    return {
      type: 'webauthn-es256' as const,
      clientDataJSON_b64u: b64url(clientDataBytes),
      authenticatorData_b64u: b64url(authenticatorData),
      signature_b64u: b64url(signature),
    }
  }

  it('verifies a genuine WebAuthn assertion', () => {
    const sig = buildAssertion(payload)
    expect(verifyMandateSignature(payload, sig, credential)).toBe(true)
  })

  it('rejects a tampered challenge (assertion signed over a different payload)', () => {
    const otherPayload = canonicalJson({ cartId: 'cart-2', total_paise: 999 })
    const sig = buildAssertion(otherPayload)
    expect(verifyMandateSignature(payload, sig, credential)).toBe(false)
  })

  it('rejects a clientData type other than webauthn.get', () => {
    const clientData = JSON.stringify({
      type: 'webauthn.create',
      challenge: sha256B64url(payload),
      origin: 'https://example.test',
    })
    const clientDataBytes = new TextEncoder().encode(clientData)
    const authenticatorData = new Uint8Array(37)
    authenticatorData[32] = 0x05
    const signedData = new Uint8Array(authenticatorData.length + 32)
    signedData.set(authenticatorData, 0)
    signedData.set(sha256(clientDataBytes), authenticatorData.length)
    const signature = p256.sign(signedData, secretKey, { format: 'der' })

    const sig = {
      type: 'webauthn-es256' as const,
      clientDataJSON_b64u: b64url(clientDataBytes),
      authenticatorData_b64u: b64url(authenticatorData),
      signature_b64u: b64url(signature),
    }
    expect(verifyMandateSignature(payload, sig, credential)).toBe(false)
  })
})
