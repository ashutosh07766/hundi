import { canonicalJson, intentSigningBytes, verifyMandateSignature } from '@hundi/core'
import { describe, expect, it } from 'vitest'
import type { HumanSign } from '../lib/intent.js'
import { buildSignedIntent, signApprovalDecision, signRevoke } from '../lib/intent.js'
import type { HumanKeypair } from '../lib/signing.js'
import { generateKeypair, signBytes } from '../lib/signing.js'

const AGENT_PUBKEY = 'aa'.repeat(32)

/** The ed25519 signer wired as a `HumanSign` — exactly what
 * `human-signer.ts`'s dispatcher produces in ed25519 mode. */
function ed25519Signer(human: HumanKeypair): HumanSign {
  return async (bytes) => signBytes(human.secretKeyHex, bytes)
}

function ed25519Credential(human: HumanKeypair) {
  return { type: 'ed25519' as const, publicKey_hex: human.publicKeyHex }
}

describe('buildSignedIntent', () => {
  it('produces a mandate with integer paise fields', async () => {
    const human = generateKeypair()
    const { intent } = await buildSignedIntent(
      {
        goal: 'Restock snacks',
        ceilingPaise: 200000,
        approvalThresholdPaise: 50000,
        merchants: ['merchant-1'],
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
        agentPubkeyHex: AGENT_PUBKEY,
      },
      ed25519Signer(human),
      ed25519Credential(human),
    )
    expect(Number.isInteger(intent.ceiling_paise)).toBe(true)
    expect(Number.isInteger(intent.approval_threshold_paise)).toBe(true)
    expect(intent.currency).toBe('INR')
  })

  it('attests the distinct agent key while registering the human key as the credential', async () => {
    const human = generateKeypair()
    const { intent, credential } = await buildSignedIntent(
      {
        goal: 'Restock snacks',
        ceilingPaise: 200000,
        approvalThresholdPaise: 50000,
        merchants: ['merchant-1'],
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
        agentPubkeyHex: AGENT_PUBKEY,
      },
      ed25519Signer(human),
      ed25519Credential(human),
    )
    // The two-key model: the intent names the agent key as the cart signer, but
    // the registered credential is the human key — they are different parties.
    expect(intent.agent_pubkey_hex).toBe(AGENT_PUBKEY)
    expect(intent.agent_pubkey_hex).not.toBe(human.publicKeyHex)
    expect(credential).toEqual({ type: 'ed25519', publicKey_hex: human.publicKeyHex })
  })

  it('produces a signature core.verifyMandateSignature accepts (ed25519 default path)', async () => {
    const human = generateKeypair()
    const { intent, credential } = await buildSignedIntent(
      {
        goal: 'Restock snacks',
        ceilingPaise: 200000,
        approvalThresholdPaise: 50000,
        merchants: ['merchant-1', 'merchant-2'],
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
        agentPubkeyHex: AGENT_PUBKEY,
      },
      ed25519Signer(human),
      ed25519Credential(human),
    )
    const bytes = intentSigningBytes(intent)
    expect(verifyMandateSignature(bytes, intent.sig, credential)).toBe(true)
  })

  it('produces canonical bytes — same input always signs the same message', async () => {
    const human = generateKeypair()
    const input = {
      goal: 'Restock snacks',
      ceilingPaise: 200000,
      approvalThresholdPaise: 50000,
      merchants: ['merchant-1'],
      expiresAt: 1_700_000_000,
      agentPubkeyHex: AGENT_PUBKEY,
    }
    const sign = ed25519Signer(human)
    const credential = ed25519Credential(human)
    const first = await buildSignedIntent(input, sign, credential)
    // mandateId is freshly generated each call, so compare signing bytes with mandateId pinned.
    const second = await buildSignedIntent(input, sign, credential)
    const bytesA = intentSigningBytes({ ...first.intent, mandateId: 'fixed' })
    const bytesB = intentSigningBytes({ ...second.intent, mandateId: 'fixed' })
    expect(Buffer.from(bytesA).toString('hex')).toBe(Buffer.from(bytesB).toString('hex'))
  })

  it('assigns a fresh mandateId on every call', async () => {
    const human = generateKeypair()
    const input = {
      goal: 'Restock snacks',
      ceilingPaise: 200000,
      approvalThresholdPaise: 50000,
      merchants: ['merchant-1'],
      expiresAt: 1_700_000_000,
      agentPubkeyHex: AGENT_PUBKEY,
    }
    const sign = ed25519Signer(human)
    const credential = ed25519Credential(human)
    const a = await buildSignedIntent(input, sign, credential)
    const b = await buildSignedIntent(input, sign, credential)
    expect(a.intent.mandateId).not.toBe(b.intent.mandateId)
  })
})

describe('signApprovalDecision', () => {
  it('signs bytes that verify against the human credential', async () => {
    const human = generateKeypair()
    const sig = await signApprovalDecision(
      { settlementId: 'settle-1', mandateCartHashHex: 'deadbeef', decision: 'approved' },
      ed25519Signer(human),
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

  it('produces a different signature for a different decision', async () => {
    const human = generateKeypair()
    const sign = ed25519Signer(human)
    const approved = await signApprovalDecision(
      { settlementId: 'settle-1', mandateCartHashHex: 'deadbeef', decision: 'approved' },
      sign,
    )
    const rejected = await signApprovalDecision(
      { settlementId: 'settle-1', mandateCartHashHex: 'deadbeef', decision: 'rejected' },
      sign,
    )
    expect(approved).not.toEqual(rejected)
  })
})

describe('signRevoke', () => {
  it('signs bytes that verify against the human credential', async () => {
    const human = generateKeypair()
    const sig = await signRevoke('mandate-1', ed25519Signer(human))
    const bytes = canonicalJson({ mandateId: 'mandate-1', action: 'revoke' })
    expect(
      verifyMandateSignature(bytes, sig, { type: 'ed25519', publicKey_hex: human.publicKeyHex }),
    ).toBe(true)
  })

  it('does not verify against a different mandateId', async () => {
    const human = generateKeypair()
    const sig = await signRevoke('mandate-1', ed25519Signer(human))
    const wrongBytes = canonicalJson({ mandateId: 'mandate-2', action: 'revoke' })
    expect(
      verifyMandateSignature(wrongBytes, sig, {
        type: 'ed25519',
        publicKey_hex: human.publicKeyHex,
      }),
    ).toBe(false)
  })
})
