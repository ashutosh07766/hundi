import { canonicalJson, verifyMandateSignature } from '@hundi/core'
import { describe, expect, it } from 'vitest'
import type { HumanIdentity } from '../lib/human-signer.js'
import { humanSign, resolveHumanCredential } from '../lib/human-signer.js'
import { generateKeypair } from '../lib/signing.js'

const payload = canonicalJson({ mandateId: 'mandate-1', action: 'revoke' })

function ed25519Identity(): HumanIdentity {
  return { mode: 'ed25519', ed25519: generateKeypair(), passkey: null, rpId: 'localhost' }
}

describe('humanSign — ed25519 mode (the default path)', () => {
  it('produces an envelope core.verifyMandateSignature accepts against the ed25519 credential', async () => {
    const identity = ed25519Identity()
    const sig = await humanSign(identity, payload)
    const credential = resolveHumanCredential(identity)
    expect(credential).toEqual({ type: 'ed25519', publicKey_hex: identity.ed25519.publicKeyHex })
    expect(sig.type).toBe('ed25519')
    expect(verifyMandateSignature(payload, sig, credential)).toBe(true)
  })

  it('is the mode a fresh identity boots into — passkey requires an explicit registered credential', () => {
    const identity = ed25519Identity()
    expect(identity.mode).toBe('ed25519')
    expect(identity.passkey).toBeNull()
  })
})

describe('resolveHumanCredential — passkey mode falls back to ed25519 when nothing is registered yet', () => {
  it('never claims passkey mode active without a registered credential', () => {
    const identity: HumanIdentity = {
      mode: 'passkey',
      ed25519: generateKeypair(),
      passkey: null,
      rpId: 'localhost',
    }
    // No registered passkey — dispatch must not silently report a webauthn
    // credential it can't actually sign with.
    expect(resolveHumanCredential(identity)).toEqual({
      type: 'ed25519',
      publicKey_hex: identity.ed25519.publicKeyHex,
    })
  })

  it('resolves the webauthn-es256 credential once a passkey is registered', () => {
    const jwk: JsonWebKey = { kty: 'EC', crv: 'P-256', x: 'x'.repeat(43), y: 'y'.repeat(43) }
    const identity: HumanIdentity = {
      mode: 'passkey',
      ed25519: generateKeypair(),
      passkey: { credentialId: 'cred-1', publicKey_jwk: jwk },
      rpId: 'localhost',
    }
    expect(resolveHumanCredential(identity)).toEqual({ type: 'webauthn-es256', publicKey_jwk: jwk })
  })
})
