import { canonicalJson, sha256B64url, verifyMandateSignature } from '@hundi/core'
import { p256 } from '@noble/curves/nist.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { describe, expect, it } from 'vitest'
import {
  buildWebauthnEnvelope,
  decodeAuthDataPublicKeyJwk,
  spkiDerToP256Jwk,
} from '../lib/webauthn.js'

function b64url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

// No real authenticator is available in CI — every fixture below is hand-built
// to the exact byte layout WebAuthn/COSE/SPKI specify, so the decoders can be
// proven correct without hardware.

describe('decodeAuthDataPublicKeyJwk', () => {
  // A known COSE EC2 key: kty=2(EC2), alg=-7(ES256), crv=1(P-256), fixed x/y.
  const x = new Uint8Array(32).fill(0x11)
  const y = new Uint8Array(32).fill(0x22)

  function buildCoseEc2Key(xBytes: Uint8Array, yBytes: Uint8Array): Uint8Array {
    // CBOR map, 5 pairs: {1: 2, 3: -7, -1: 1, -2: bstr(x), -3: bstr(y)}
    return new Uint8Array([
      0xa5, // map(5)
      0x01,
      0x02, // 1: 2 (kty: EC2)
      0x03,
      0x26, // 3: -7 (alg: ES256)
      0x20,
      0x01, // -1: 1 (crv: P-256)
      0x21,
      0x58,
      0x20,
      ...xBytes, // -2: bstr(32) x
      0x22,
      0x58,
      0x20,
      ...yBytes, // -3: bstr(32) y
    ])
  }

  function buildAuthenticatorData(coseKey: Uint8Array, credId: Uint8Array): Uint8Array {
    const rpIdHash = new Uint8Array(32)
    const flags = new Uint8Array([0x41]) // UP + AT
    const signCount = new Uint8Array(4)
    const aaguid = new Uint8Array(16)
    const credIdLen = new Uint8Array([(credId.length >> 8) & 0xff, credId.length & 0xff])
    return new Uint8Array([
      ...rpIdHash,
      ...flags,
      ...signCount,
      ...aaguid,
      ...credIdLen,
      ...credId,
      ...coseKey,
    ])
  }

  it('extracts the correct {x, y} JWK from a known COSE EC2 fixture', () => {
    const authData = buildAuthenticatorData(buildCoseEc2Key(x, y), new Uint8Array([0xaa, 0xbb]))
    const jwk = decodeAuthDataPublicKeyJwk(authData)
    expect(jwk).toEqual({ kty: 'EC', crv: 'P-256', x: b64url(x), y: b64url(y) })
  })

  it('rejects authenticatorData with no attested credential data', () => {
    const noAttestedData = new Uint8Array(37) // flags byte (offset 32) left at 0 — AT unset
    expect(() => decodeAuthDataPublicKeyJwk(noAttestedData)).toThrow(/AT flag unset/)
  })

  it('rejects a COSE key that is not EC2/P-256', () => {
    // kty=1 (OKP) instead of 2 (EC2) — same map shape otherwise.
    const wrongKty = new Uint8Array([
      0xa5,
      0x01,
      0x01,
      0x03,
      0x26,
      0x20,
      0x01,
      0x21,
      0x58,
      0x20,
      ...x,
      0x22,
      0x58,
      0x20,
      ...y,
    ])
    const authData = buildAuthenticatorData(wrongKty, new Uint8Array([0xaa]))
    expect(() => decodeAuthDataPublicKeyJwk(authData)).toThrow(/EC2\/P-256/)
  })
})

describe('spkiDerToP256Jwk', () => {
  it('extracts {x, y} from a P-256 SPKI DER key', () => {
    const secretKey = p256.utils.randomSecretKey()
    const uncompressed = p256.getPublicKey(secretKey, false) // 0x04 || x(32) || y(32)
    const x = uncompressed.slice(1, 33)
    const y = uncompressed.slice(33, 65)

    // Real SPKI DER has an ASN.1 header before the point; the decoder only reads
    // the trailing 65 bytes, so a minimal prefix is enough to prove that contract.
    const spkiDer = new Uint8Array([...new Uint8Array(26).fill(0), ...uncompressed])
    const jwk = spkiDerToP256Jwk(spkiDer)
    expect(jwk).toEqual({ kty: 'EC', crv: 'P-256', x: b64url(x), y: b64url(y) })
  })

  it('rejects a buffer whose trailing 65 bytes are not an uncompressed point', () => {
    expect(() => spkiDerToP256Jwk(new Uint8Array(65))).toThrow(/unexpected SPKI shape/)
  })
})

describe('buildWebauthnEnvelope — packaging proven against @hundi/core verification', () => {
  // Mirrors packages/core/src/__tests__/signature.test.ts's own webauthn-es256
  // construction: a synthetic assertion signed with a freshly generated P-256
  // key, registered as the credential. No real authenticator involved — this
  // proves the dashboard's envelope packaging (field renames, base64url
  // shapes) round-trips through core's verifier correctly.
  const payload = canonicalJson({ settlement_id: 'settle-1', decision: 'approved' })
  const secretKey = p256.utils.randomSecretKey()
  const publicKeyBytes = p256.getPublicKey(secretKey, false)
  const jwk: JsonWebKey = {
    kty: 'EC',
    crv: 'P-256',
    x: b64url(publicKeyBytes.slice(1, 33)),
    y: b64url(publicKeyBytes.slice(33, 65)),
  }
  const credential = { type: 'webauthn-es256' as const, publicKey_jwk: jwk }

  function fakeAssertionResponse(challengeSource: Uint8Array) {
    const clientData = JSON.stringify({
      type: 'webauthn.get',
      challenge: sha256B64url(challengeSource),
      origin: 'http://localhost:5173',
    })
    const clientDataBytes = new TextEncoder().encode(clientData)
    const authenticatorData = new Uint8Array(37)
    authenticatorData[32] = 0x05 // UP + UV

    const signedData = new Uint8Array(authenticatorData.length + 32)
    signedData.set(authenticatorData, 0)
    signedData.set(sha256(clientDataBytes), authenticatorData.length)
    const signature = p256.sign(signedData, secretKey, { format: 'der' })

    return {
      clientDataJSON: b64url(clientDataBytes),
      authenticatorData: b64url(authenticatorData),
      signature: b64url(signature),
    }
  }

  it('produces an envelope core.verifyMandateSignature accepts for a genuine assertion', () => {
    const envelope = buildWebauthnEnvelope(fakeAssertionResponse(payload))
    expect(envelope.type).toBe('webauthn-es256')
    expect(verifyMandateSignature(payload, envelope, credential)).toBe(true)
  })

  it('rejects an assertion signed over a different payload (challenge mismatch)', () => {
    const otherPayload = canonicalJson({ settlement_id: 'settle-2', decision: 'rejected' })
    const envelope = buildWebauthnEnvelope(fakeAssertionResponse(otherPayload))
    expect(verifyMandateSignature(payload, envelope, credential)).toBe(false)
  })
})
