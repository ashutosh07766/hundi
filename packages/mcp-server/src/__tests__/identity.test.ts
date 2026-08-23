import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { cartSigningBytes, verifyMandateSignature } from '@hundi/core'
import { afterEach, describe, expect, it } from 'vitest'
import { signPayload } from '../../../../agents/scripted-brain/src/ed25519.js'
import { loadOrCreateAgentIdentity } from '../identity.js'

describe('loadOrCreateAgentIdentity', () => {
  let dir: string | undefined

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
    dir = undefined
  })

  it('returns a stable public key across two server constructions with the same key file', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'hundi-mcp-identity-'))
    const keyFile = path.join(dir, 'agent-key.json')

    const first = loadOrCreateAgentIdentity(keyFile)
    const second = loadOrCreateAgentIdentity(keyFile)

    expect(second.publicKeyHex).toBe(first.publicKeyHex)
    expect(first.publicKeyHex).toMatch(/^[0-9a-f]{64}$/)
  })

  it('mints distinct keys for distinct, not-yet-existing key files', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'hundi-mcp-identity-'))
    const a = loadOrCreateAgentIdentity(path.join(dir, 'a.json'))
    const b = loadOrCreateAgentIdentity(path.join(dir, 'b.json'))
    expect(a.publicKeyHex).not.toBe(b.publicKeyHex)
  })

  it('persists the key file readable/writable by the owner only', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'hundi-mcp-identity-'))
    const keyFile = path.join(dir, 'agent-key.json')
    loadOrCreateAgentIdentity(keyFile)
    const mode = statSync(keyFile).mode & 0o777
    expect(mode).toBe(0o600)
  })

  it('the reloaded private key signs bytes that verify against the same public key', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'hundi-mcp-identity-'))
    const keyFile = path.join(dir, 'agent-key.json')

    loadOrCreateAgentIdentity(keyFile) // mints and persists
    const reloaded = loadOrCreateAgentIdentity(keyFile) // reads back from disk

    const payload = cartSigningBytes({
      cartId: 'cart-1',
      merchant_id: 'demo-store-1',
      items: [{ sku: 'sku-1', qty: 1, unit_price_paise: 100 }],
      total_paise: 100,
      intent_hash_hex: 'a'.repeat(64),
    })
    const sig = signPayload(reloaded.privateKey, payload)

    expect(
      verifyMandateSignature(payload, sig, {
        type: 'ed25519',
        publicKey_hex: reloaded.publicKeyHex,
      }),
    ).toBe(true)
  })
})
