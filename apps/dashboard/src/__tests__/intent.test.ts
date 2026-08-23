import { canonicalJson, intentSigningBytes, verifyMandateSignature } from '@hundi/core'
import { describe, expect, it } from 'vitest'
import { buildSignedIntent, signApprovalDecision, signRevoke } from '../lib/intent.js'
import { generateKeypair } from '../lib/signing.js'

describe('buildSignedIntent', () => {
  it('produces a mandate with integer paise fields', () => {
    const human = generateKeypair()
    const { intent } = buildSignedIntent(
      {
        goal: 'Restock snacks',
        ceilingPaise: 200000,
        approvalThresholdPaise: 50000,
        merchants: ['merchant-1'],
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
      },
      human,
    )
    expect(Number.isInteger(intent.ceiling_paise)).toBe(true)
    expect(Number.isInteger(intent.approval_threshold_paise)).toBe(true)
    expect(intent.currency).toBe('INR')
  })

  it('binds the intent to the human key as both agent and credential', () => {
    const human = generateKeypair()
    const { intent, credential } = buildSignedIntent(
      {
        goal: 'Restock snacks',
        ceilingPaise: 200000,
        approvalThresholdPaise: 50000,
        merchants: ['merchant-1'],
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
      },
      human,
    )
    expect(intent.agent_pubkey_hex).toBe(human.publicKeyHex)
    expect(credential).toEqual({ type: 'ed25519', publicKey_hex: human.publicKeyHex })
  })

  it('produces a signature core.verifyMandateSignature accepts', () => {
    const human = generateKeypair()
    const { intent, credential } = buildSignedIntent(
      {
        goal: 'Restock snacks',
        ceilingPaise: 200000,
        approvalThresholdPaise: 50000,
        merchants: ['merchant-1', 'merchant-2'],
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
      },
      human,
    )
    const bytes = intentSigningBytes(intent)
    expect(verifyMandateSignature(bytes, intent.sig, credential)).toBe(true)
  })

  it('produces canonical bytes — same input always signs the same message', () => {
    const human = generateKeypair()
    const input = {
      goal: 'Restock snacks',
      ceilingPaise: 200000,
      approvalThresholdPaise: 50000,
      merchants: ['merchant-1'],
      expiresAt: 1_700_000_000,
    }
    const first = buildSignedIntent(input, human)
    // mandateId is freshly generated each call, so compare signing bytes with mandateId pinned.
    const bytesA = intentSigningBytes({ ...first.intent, mandateId: 'fixed' })
    const bytesB = intentSigningBytes({
      ...buildSignedIntent(input, human).intent,
      mandateId: 'fixed',
    })
    expect(Buffer.from(bytesA).toString('hex')).toBe(Buffer.from(bytesB).toString('hex'))
  })

  it('assigns a fresh mandateId on every call', () => {
    const human = generateKeypair()
    const input = {
      goal: 'Restock snacks',
      ceilingPaise: 200000,
      approvalThresholdPaise: 50000,
      merchants: ['merchant-1'],
      expiresAt: 1_700_000_000,
    }
    const a = buildSignedIntent(input, human)
    const b = buildSignedIntent(input, human)
    expect(a.intent.mandateId).not.toBe(b.intent.mandateId)
  })
})

describe('signApprovalDecision', () => {
  it('signs bytes that verify against the human credential', () => {
    const human = generateKeypair()
    const sig = signApprovalDecision(
      { settlementId: 'settle-1', mandateCartHashHex: 'deadbeef', decision: 'approved' },
      human,
    )
    const bytes = canonicalJson({
      settlement_id: 'settle-1',
      mandate_cart_hash_hex: 'deadbeef',
      decision: 'approved',
    })
    expect(
      verifyMandateSignature(bytes, sig, { type: 'ed25519', publicKey_hex: human.publicKeyHex }),
    ).toBe(true)
  })

  it('produces a different signature for a different decision', () => {
    const human = generateKeypair()
    const approved = signApprovalDecision(
      { settlementId: 'settle-1', mandateCartHashHex: 'deadbeef', decision: 'approved' },
      human,
    )
    const rejected = signApprovalDecision(
      { settlementId: 'settle-1', mandateCartHashHex: 'deadbeef', decision: 'rejected' },
      human,
    )
    expect(approved.signature_hex).not.toBe(rejected.signature_hex)
  })
})

describe('signRevoke', () => {
  it('signs bytes that verify against the human credential', () => {
    const human = generateKeypair()
    const sig = signRevoke('mandate-1', human)
    const bytes = canonicalJson({ mandateId: 'mandate-1', action: 'revoke' })
    expect(
      verifyMandateSignature(bytes, sig, { type: 'ed25519', publicKey_hex: human.publicKeyHex }),
    ).toBe(true)
  })

  it('does not verify against a different mandateId', () => {
    const human = generateKeypair()
    const sig = signRevoke('mandate-1', human)
    const wrongBytes = canonicalJson({ mandateId: 'mandate-2', action: 'revoke' })
    expect(
      verifyMandateSignature(wrongBytes, sig, {
        type: 'ed25519',
        publicKey_hex: human.publicKeyHex,
      }),
    ).toBe(false)
  })
})
