/**
 * Browser-side WebAuthn ceremony for the human signer identity. Every
 * function below either builds request options for `navigator.credentials`
 * (via `@simplewebauthn/browser`) or repackages what the browser hands back
 * — this module never holds a private key. That's the property that makes
 * the passkey path a real upgrade over `signing.ts`'s raw Ed25519 keypair:
 * the platform authenticator (Secure Enclave, TPM, StrongBox) signs, the
 * page only ever sees a public key and, per-ceremony, an assertion.
 *
 * Platform authenticators issue ES256 (COSE alg -7) regardless of what a
 * caller puts first in `pubKeyCredParams` — iCloud Keychain, Windows Hello,
 * and Android's StrongBox all do this in practice. So registration requests
 * ES256 only, and treats any other reported algorithm as a hard failure:
 * `@hundi/core`'s verifier only implements the `webauthn-es256` credential
 * type, so a passkey issuing anything else can never be verified downstream
 * anyway — better to fail at registration than mint a mandate credential
 * that can never sign anything.
 *
 * No server-side WebAuthn library is involved. `@hundi/core` already
 * verifies `webauthn-es256` assertions against a raw P-256 JWK
 * (`packages/core/src/signature.ts`); this module's only job is producing
 * that JWK at registration time and that assertion shape at sign time.
 */

import type { SigEnvelope } from '@hundi/core'
import { decodeBase64Url, sha256B64url } from '@hundi/core'
import type {
  AuthenticationResponseJSON,
  AuthenticatorAttestationResponseJSON,
} from '@simplewebauthn/browser'
import {
  browserSupportsWebAuthn,
  platformAuthenticatorIsAvailable,
  startAuthentication,
  startRegistration,
} from '@simplewebauthn/browser'

const ES256_COSE_ALG = -7

export type PasskeyIdentity = {
  /** Base64url credential id — passed back to the authenticator as `allowCredentials`
   * on every subsequent assertion. Not a secret; it just names which credential to use. */
  credentialId: string
  publicKey_jwk: JsonWebKey
}

/** No `'='` padding, matches the encoding WebAuthn itself uses for every base64url
 * field it hands back — so a value round-trips through decode+encode unchanged. */
function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** Best-effort capability probe, run before starting a ceremony so a clear message
 * ("no platform authenticator") can be shown instead of whatever error the raw
 * `navigator.credentials` call throws. Not a guarantee — the ceremony itself, not
 * this check, is the real test of whether a passkey can be created here. */
export async function isPasskeyCapable(): Promise<boolean> {
  if (typeof window === 'undefined' || !window.isSecureContext) return false
  if (!browserSupportsWebAuthn()) return false
  try {
    return await platformAuthenticatorIsAvailable()
  } catch {
    return false
  }
}

/** SPKI DER for a P-256 key is a fixed-shape structure — algorithm identifier
 * OIDs followed by a BIT STRING wrapping the uncompressed EC point
 * (`0x04 || X(32) || Y(32)`). Rather than a general ASN.1 parser, this just
 * takes the last 65 bytes and checks they look like that point — true for
 * every P-256 SPKI key, since the point is always the trailing field. */
export function spkiDerToP256Jwk(der: Uint8Array): JsonWebKey {
  const point = der.slice(-65)
  if (point.length !== 65 || point[0] !== 0x04) {
    throw new Error('spkiDerToP256Jwk: not an uncompressed P-256 point (unexpected SPKI shape)')
  }
  return {
    kty: 'EC',
    crv: 'P-256',
    x: bytesToBase64Url(point.slice(1, 33)),
    y: bytesToBase64Url(point.slice(33, 65)),
  }
}

// --- Minimal CBOR decoder --------------------------------------------------
//
// Fallback path for browsers/authenticators that don't expose
// `AuthenticatorAttestationResponse.getPublicKey()` (SPKI DER) — decodes the
// COSE_Key CBOR map embedded in `authenticatorData` ourselves. Scoped to
// exactly what a WebAuthn attestation object and COSE_Key can contain
// (unsigned/negative ints, byte strings, text strings, arrays, maps, and the
// few simple values). Indefinite-length items are out of scope — neither
// structure produces them.

type CborValue = number | bigint | string | boolean | null | Uint8Array | CborValue[] | CborMap
type CborMap = Map<string | number, CborValue>

function decodeCborValue(bytes: Uint8Array, offset: number): { value: CborValue; offset: number } {
  const initial = bytes[offset]
  if (initial === undefined) throw new Error('decodeCborValue: unexpected end of input')
  const majorType = initial >> 5
  const info = initial & 0x1f
  offset += 1

  let length: number
  if (info < 24) {
    length = info
  } else if (info === 24) {
    length = bytes[offset] as number
    offset += 1
  } else if (info === 25) {
    length = ((bytes[offset] as number) << 8) | (bytes[offset + 1] as number)
    offset += 2
  } else if (info === 26) {
    length =
      (((bytes[offset] as number) << 24) |
        ((bytes[offset + 1] as number) << 16) |
        ((bytes[offset + 2] as number) << 8) |
        (bytes[offset + 3] as number)) >>>
      0
    offset += 4
  } else if (info === 27) {
    // 8-byte length. WebAuthn structures never need this, but decode rather
    // than silently truncate if an authenticator ever emits one.
    let big = 0n
    for (let i = 0; i < 8; i++) big = (big << 8n) | BigInt(bytes[offset + i] as number)
    offset += 8
    length = Number(big)
  } else {
    throw new Error('decodeCborValue: indefinite-length CBOR items are not supported')
  }

  switch (majorType) {
    case 0:
      return { value: length, offset }
    case 1:
      return { value: -1 - length, offset }
    case 2:
      return { value: bytes.slice(offset, offset + length), offset: offset + length }
    case 3:
      return {
        value: new TextDecoder().decode(bytes.slice(offset, offset + length)),
        offset: offset + length,
      }
    case 4: {
      const arr: CborValue[] = []
      for (let i = 0; i < length; i++) {
        const item = decodeCborValue(bytes, offset)
        arr.push(item.value)
        offset = item.offset
      }
      return { value: arr, offset }
    }
    case 5: {
      const map: CborMap = new Map()
      for (let i = 0; i < length; i++) {
        const key = decodeCborValue(bytes, offset)
        offset = key.offset
        const val = decodeCborValue(bytes, offset)
        offset = val.offset
        map.set(key.value as string | number, val.value)
      }
      return { value: map, offset }
    }
    case 7:
      if (info === 20) return { value: false, offset }
      if (info === 21) return { value: true, offset }
      if (info === 22) return { value: null, offset }
      throw new Error(`decodeCborValue: unsupported simple value (info=${info})`)
    default:
      throw new Error(`decodeCborValue: unsupported major type ${majorType}`)
  }
}

function extractAuthDataFromAttestationObject(attestationObject: Uint8Array): Uint8Array {
  const { value } = decodeCborValue(attestationObject, 0)
  if (!(value instanceof Map)) throw new Error('attestationObject is not a CBOR map')
  const authData = value.get('authData')
  if (!(authData instanceof Uint8Array)) throw new Error('attestationObject.authData missing')
  return authData
}

// authenticatorData layout (WebAuthn §6.1): rpIdHash(32) | flags(1) | signCount(4)
// | [attestedCredentialData: aaguid(16) | credIdLen(2, BE) | credId(credIdLen) | credentialPublicKey(CBOR)]
const AUTH_DATA_FLAGS_OFFSET = 32
const AUTH_DATA_SIGN_COUNT_LEN = 4
const AUTH_DATA_AAGUID_LEN = 16
const AUTH_DATA_CRED_ID_LEN_SIZE = 2
const AUTH_DATA_FLAG_ATTESTED_CREDENTIAL_DATA = 0x40

const COSE_KEY_KTY = 1
const COSE_KEY_CRV = -1
const COSE_KEY_X = -2
const COSE_KEY_Y = -3
const COSE_KTY_EC2 = 2
const COSE_CRV_P256 = 1

/** Decodes the COSE EC2 public key embedded in `authenticatorData`'s attested
 * credential data and converts it to a P-256 JWK. Exported for direct testing
 * against a hand-built fixture — real hardware isn't available in CI. */
export function decodeAuthDataPublicKeyJwk(authData: Uint8Array): JsonWebKey {
  const flags = authData[AUTH_DATA_FLAGS_OFFSET]
  if (flags === undefined || (flags & AUTH_DATA_FLAG_ATTESTED_CREDENTIAL_DATA) === 0) {
    throw new Error('authenticatorData has no attested credential data (AT flag unset)')
  }
  const aaguidOffset = AUTH_DATA_FLAGS_OFFSET + 1 + AUTH_DATA_SIGN_COUNT_LEN
  const credIdLenOffset = aaguidOffset + AUTH_DATA_AAGUID_LEN
  const credIdLen =
    ((authData[credIdLenOffset] as number) << 8) | (authData[credIdLenOffset + 1] as number)
  const publicKeyOffset = credIdLenOffset + AUTH_DATA_CRED_ID_LEN_SIZE + credIdLen

  const { value: cose } = decodeCborValue(authData, publicKeyOffset)
  if (!(cose instanceof Map)) throw new Error('credentialPublicKey is not a CBOR map')

  const kty = cose.get(COSE_KEY_KTY)
  const crv = cose.get(COSE_KEY_CRV)
  const x = cose.get(COSE_KEY_X)
  const y = cose.get(COSE_KEY_Y)
  if (
    kty !== COSE_KTY_EC2 ||
    crv !== COSE_CRV_P256 ||
    !(x instanceof Uint8Array) ||
    !(y instanceof Uint8Array)
  ) {
    throw new Error('credentialPublicKey is not an EC2/P-256 COSE key')
  }
  return { kty: 'EC', crv: 'P-256', x: bytesToBase64Url(x), y: bytesToBase64Url(y) }
}

function extractP256Jwk(response: AuthenticatorAttestationResponseJSON): JsonWebKey {
  // Preferred path: modern browsers expose the parsed SPKI key directly via
  // `AuthenticatorAttestationResponse.getPublicKey()` — no CBOR involved.
  if (response.publicKey) {
    return spkiDerToP256Jwk(decodeBase64Url(response.publicKey))
  }
  const authData = response.authenticatorData
    ? decodeBase64Url(response.authenticatorData)
    : extractAuthDataFromAttestationObject(decodeBase64Url(response.attestationObject))
  return decodeAuthDataPublicKeyJwk(authData)
}

/** Runs the registration ceremony (`navigator.credentials.create`) and returns the
 * new passkey's credential id plus its public key as a JWK. Requires a user gesture —
 * call this directly from a click handler, not from an effect. Attestation is
 * requested as `'none'`: this dashboard never checks attestation statements (there's
 * no server-side allow-list of authenticator models to check against), so asking for
 * more than `'none'` would only prompt the user for information nothing here uses. */
export async function registerPasskey(args: {
  rpId: string
  rpName: string
  userName: string
  userDisplayName: string
}): Promise<PasskeyIdentity> {
  const userIdBytes = crypto.getRandomValues(new Uint8Array(16))
  const challengeBytes = crypto.getRandomValues(new Uint8Array(32))

  const response = await startRegistration({
    optionsJSON: {
      rp: { id: args.rpId, name: args.rpName },
      user: {
        id: bytesToBase64Url(userIdBytes),
        name: args.userName,
        displayName: args.userDisplayName,
      },
      challenge: bytesToBase64Url(challengeBytes),
      pubKeyCredParams: [{ alg: ES256_COSE_ALG, type: 'public-key' }],
      attestation: 'none',
      authenticatorSelection: { userVerification: 'preferred', residentKey: 'preferred' },
    },
  })

  const algorithm = response.response.publicKeyAlgorithm
  if (algorithm !== undefined && algorithm !== ES256_COSE_ALG) {
    throw new Error(
      `Authenticator issued algorithm ${algorithm}, but only ES256 (-7) is supported — @hundi/core's verifier has no other webauthn-es256 branch.`,
    )
  }

  return { credentialId: response.id, publicKey_jwk: extractP256Jwk(response.response) }
}

/** Packages a completed assertion into the `webauthn-es256` SigEnvelope shape
 * `@hundi/core`'s `verifyMandateSignature` expects. Every field on
 * `AuthenticationResponseJSON['response']` is already the exact base64url string
 * core wants — this is a rename, not a transform. Exported separately from
 * `signWithPasskey` so the packaging can be proven correct against a synthetic
 * assertion in tests, without a real authenticator. */
export function buildWebauthnEnvelope(
  response: Pick<
    AuthenticationResponseJSON['response'],
    'clientDataJSON' | 'authenticatorData' | 'signature'
  >,
): Extract<SigEnvelope, { type: 'webauthn-es256' }> {
  return {
    type: 'webauthn-es256',
    clientDataJSON_b64u: response.clientDataJSON,
    authenticatorData_b64u: response.authenticatorData,
    signature_b64u: response.signature,
  }
}

/** Signs `payloadBytes` as an assertion against the given credential
 * (`navigator.credentials.get`). The challenge is `sha256B64url(payloadBytes)` —
 * `@hundi/core`'s verifier recomputes that exact value and compares it against
 * `clientDataJSON.challenge`, so this must stay byte-for-byte the same hash
 * pipeline as core's, which it is: both call the same `sha256B64url` export. */
export async function signWithPasskey(
  payloadBytes: Uint8Array,
  credentialId: string,
  rpId: string,
): Promise<Extract<SigEnvelope, { type: 'webauthn-es256' }>> {
  const response = await startAuthentication({
    optionsJSON: {
      challenge: sha256B64url(payloadBytes),
      rpId,
      allowCredentials: [{ id: credentialId, type: 'public-key' }],
      userVerification: 'preferred',
    },
  })
  return buildWebauthnEnvelope(response.response)
}
