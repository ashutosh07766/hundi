import { intentSigningBytes, verifyMandateSignature } from '@hundi/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MandateProposal } from '../lib/api.js'
import type { HumanSign } from '../lib/intent.js'
import { approveMandateProposal } from '../lib/proposal-approval.js'
import { generateKeypair, signBytes } from '../lib/signing.js'

const AGENT_PUBKEY = 'aa'.repeat(32)

function ed25519Signer(human: ReturnType<typeof generateKeypair>): HumanSign {
  return async (bytes) => signBytes(human.secretKeyHex, bytes)
}

function makeProposal(overrides: Partial<MandateProposal> = {}): MandateProposal {
  return {
    id: 'proposal-1',
    merchant_id: 'myfrido-com',
    goal: 'shop Frido',
    ceiling_paise: 500_000,
    approval_threshold_paise: 500_000,
    currency: 'INR',
    agent_pubkey_hex: AGENT_PUBKEY,
    expires_at: 1_900_000_000,
    status: 'pending',
    created_at: 1,
    summary: 'Give the agent up to ₹5,000.00 to "shop Frido" at myfrido-com.',
    ...overrides,
  }
}

describe('approveMandateProposal', () => {
  const originalFetch = globalThis.fetch

  beforeEach(() => vi.restoreAllMocks())
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('signs, mints a ceremony token, registers the mandate, then consumes the proposal — in that order', async () => {
    const human = generateKeypair()
    const proposal = makeProposal()
    const calls: Array<{ url: string; init: RequestInit | undefined }> = []

    const mockFetch = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init })
      if (url.endsWith('/ceremony-tokens')) {
        return new Response(JSON.stringify({ ok: true, ceremonyToken: 'token-abc' }), {
          status: 201,
        })
      }
      if (url.endsWith('/mandates')) {
        return new Response(
          JSON.stringify({ ok: true, mandateId: 'mandate-9', intent_hash_hex: 'c'.repeat(64) }),
          { status: 201 },
        )
      }
      if (url.endsWith('/mandates/proposals/proposal-1/consume')) {
        return new Response(
          JSON.stringify({ ok: true, proposal: { ...proposal, status: 'consumed' } }),
          { status: 200 },
        )
      }
      throw new Error(`unexpected fetch to ${url}`)
    })
    globalThis.fetch = mockFetch as unknown as typeof fetch

    const result = await approveMandateProposal({
      proposal,
      sign: ed25519Signer(human),
      credential: { type: 'ed25519', publicKey_hex: human.publicKeyHex },
      dashboardToken: 'dashboard-test-token',
    })

    expect(result).toEqual({ mandateId: 'mandate-9', intentHashHex: 'c'.repeat(64) })

    // Order: mint ceremony token -> register mandate -> consume proposal.
    expect(calls.map((c) => c.url)).toEqual([
      expect.stringContaining('/ceremony-tokens'),
      expect.stringContaining('/mandates'),
      expect.stringContaining('/mandates/proposals/proposal-1/consume'),
    ])

    const registerCall = calls[1]
    expect(registerCall).toBeDefined()
    const registerBody = JSON.parse(registerCall?.init?.body as string) as {
      intent: { agent_pubkey_hex: string; ceiling_paise: number; merchants: string[] }
      ceremonyToken: string
    }
    expect(registerBody.ceremonyToken).toBe('token-abc')
    expect(registerBody.intent.agent_pubkey_hex).toBe(AGENT_PUBKEY)
    expect(registerBody.intent.ceiling_paise).toBe(500_000)
    expect(registerBody.intent.merchants).toEqual(['myfrido-com'])

    const consumeCall = calls[2]
    const consumeHeaders = consumeCall?.init?.headers as Record<string, string>
    expect(consumeHeaders['x-hundi-dashboard-token']).toBe('dashboard-test-token')
  })

  it('signs an intent that verifies against the human credential and attests the proposal agent key', async () => {
    const human = generateKeypair()
    const proposal = makeProposal({ ceiling_paise: 250_000, approval_threshold_paise: 100_000 })
    let signedIntentBytesHex: string | undefined

    const mockFetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/ceremony-tokens')) {
        return new Response(JSON.stringify({ ok: true, ceremonyToken: 'token-xyz' }), {
          status: 201,
        })
      }
      if (url.endsWith('/mandates')) {
        const body = JSON.parse(init?.body as string) as { intent: unknown }
        signedIntentBytesHex = Buffer.from(intentSigningBytes(body.intent as never)).toString('hex')
        return new Response(
          JSON.stringify({ ok: true, mandateId: 'mandate-1', intent_hash_hex: 'd'.repeat(64) }),
          { status: 201 },
        )
      }
      if (url.includes('/consume')) {
        return new Response(JSON.stringify({ ok: true, proposal }), { status: 200 })
      }
      throw new Error(`unexpected fetch to ${url}`)
    })
    globalThis.fetch = mockFetch as unknown as typeof fetch

    await approveMandateProposal({
      proposal,
      sign: ed25519Signer(human),
      credential: { type: 'ed25519', publicKey_hex: human.publicKeyHex },
      dashboardToken: 'dashboard-test-token',
    })

    expect(signedIntentBytesHex).toBeDefined()

    // Independently re-derive what was signed to confirm the human key actually
    // produced a signature the facilitator's own verifier would accept — re-fetch
    // isn't needed since we captured the exact intent posted above.
    const registerCall = mockFetch.mock.calls.find(([url]) => (url as string).endsWith('/mandates'))
    if (!registerCall) throw new Error('expected a POST /mandates call to have been recorded')
    const body = JSON.parse((registerCall[1] as RequestInit).body as string) as {
      intent: { sig: unknown; agent_pubkey_hex: string }
    }
    expect(body.intent.agent_pubkey_hex).toBe(AGENT_PUBKEY)
    expect(
      verifyMandateSignature(intentSigningBytes(body.intent as never), body.intent.sig as never, {
        type: 'ed25519',
        publicKey_hex: human.publicKeyHex,
      }),
    ).toBe(true)
  })

  it('does not call consume when registration fails', async () => {
    const human = generateKeypair()
    const proposal = makeProposal()
    const mockFetch = vi.fn(async (url: string) => {
      if (url.endsWith('/ceremony-tokens')) {
        return new Response(JSON.stringify({ ok: true, ceremonyToken: 'token-abc' }), {
          status: 201,
        })
      }
      if (url.endsWith('/mandates')) {
        return new Response(JSON.stringify({ ok: false, error: 'SIG_INVALID_INTENT' }), {
          status: 400,
        })
      }
      throw new Error(`unexpected fetch to ${url}`)
    })
    globalThis.fetch = mockFetch as unknown as typeof fetch

    await expect(
      approveMandateProposal({
        proposal,
        sign: ed25519Signer(human),
        credential: { type: 'ed25519', publicKey_hex: human.publicKeyHex },
        dashboardToken: 'dashboard-test-token',
      }),
    ).rejects.toThrow()

    expect(mockFetch).not.toHaveBeenCalledWith(
      expect.stringContaining('/consume'),
      expect.anything(),
    )
  })
})
