import type { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { fakeScanResult, getJson, makeTestApp, postJson, TEST_ENV } from './http-helpers.js'

const DASHBOARD_HEADERS = { 'x-hundi-dashboard-token': TEST_ENV.DASHBOARD_TOKEN }
const AGENT_PUBKEY = 'aa'.repeat(32)

async function onboardExampleStore(app: Hono): Promise<void> {
  const res = await postJson(
    app,
    '/stores/onboard',
    { url: 'https://example.com' },
    DASHBOARD_HEADERS,
  )
  expect(res.status).toBe(200)
}

function proposeBody(overrides: Record<string, unknown> = {}) {
  return {
    merchant_id: 'example-com',
    goal: 'shop Frido',
    ceiling_paise: 500_000,
    approval_threshold_paise: 500_000,
    agent_pubkey_hex: AGENT_PUBKEY,
    ...overrides,
  }
}

describe('POST /mandates/propose', () => {
  it('creates a pending proposal and returns a well-formed approve_url with no dashboard token', async () => {
    const { app } = makeTestApp({
      scanStore: async () => fakeScanResult({ merchant_id: 'example-com' }),
    })
    await onboardExampleStore(app)

    const res = await postJson(app, '/mandates/propose', proposeBody())
    expect(res.status).toBe(201)
    const json = (await res.json()) as { ok: boolean; proposal_id: string; approve_url: string }
    expect(json.ok).toBe(true)
    expect(json.proposal_id).toBeTruthy()
    expect(json.approve_url).toBe(`http://localhost:5173/?propose=${json.proposal_id}`)
  })

  it('respects DASHBOARD_URL when configured', async () => {
    const { app } = makeTestApp({
      scanStore: async () => fakeScanResult({ merchant_id: 'example-com' }),
      env: { DASHBOARD_URL: 'https://dash.example.com/' },
    })
    await onboardExampleStore(app)

    const res = await postJson(app, '/mandates/propose', proposeBody())
    const json = (await res.json()) as { proposal_id: string; approve_url: string }
    expect(json.approve_url).toBe(`https://dash.example.com/?propose=${json.proposal_id}`)
  })

  it('rejects an unknown merchant with 400 UNKNOWN_MERCHANT and creates nothing', async () => {
    const { app } = makeTestApp()
    const res = await postJson(app, '/mandates/propose', proposeBody({ merchant_id: 'nope' }))
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ ok: false, error: 'UNKNOWN_MERCHANT' })

    const list = await getJson(app, '/mandates/proposals')
    const listJson = (await list.json()) as { proposals: unknown[] }
    expect(listJson.proposals).toEqual([])
  })

  it('defaults approval_threshold_paise == ceiling_paise being interpreted as "no approvals" in the summary', async () => {
    const { app } = makeTestApp({
      scanStore: async () => fakeScanResult({ merchant_id: 'example-com' }),
    })
    await onboardExampleStore(app)

    const res = await postJson(app, '/mandates/propose', proposeBody())
    const { proposal_id } = (await res.json()) as { proposal_id: string }
    const detail = await getJson(app, `/mandates/proposals/${proposal_id}`)
    const json = (await detail.json()) as { proposal: { summary: string } }
    expect(json.proposal.summary).toContain('no purchases require approval')
  })
})

describe('GET /mandates/proposals', () => {
  it('lists proposals, filterable by status', async () => {
    const { app } = makeTestApp({
      scanStore: async () => fakeScanResult({ merchant_id: 'example-com' }),
    })
    await onboardExampleStore(app)
    const create = await postJson(app, '/mandates/propose', proposeBody())
    const { proposal_id } = (await create.json()) as { proposal_id: string }

    const all = await getJson(app, '/mandates/proposals')
    const allJson = (await all.json()) as { proposals: { id: string }[] }
    expect(allJson.proposals.map((p) => p.id)).toContain(proposal_id)

    const pending = await getJson(app, '/mandates/proposals?status=pending')
    const pendingJson = (await pending.json()) as { proposals: { id: string; status: string }[] }
    expect(pendingJson.proposals.map((p) => p.id)).toContain(proposal_id)
    expect(pendingJson.proposals.every((p) => p.status === 'pending')).toBe(true)

    const consumed = await getJson(app, '/mandates/proposals?status=consumed')
    const consumedJson = (await consumed.json()) as { proposals: { id: string }[] }
    expect(consumedJson.proposals.map((p) => p.id)).not.toContain(proposal_id)
  })
})

describe('GET /mandates/proposals/:id', () => {
  it('returns the proposal with a human-readable summary', async () => {
    const { app } = makeTestApp({
      scanStore: async () => fakeScanResult({ merchant_id: 'example-com' }),
    })
    await onboardExampleStore(app)
    const create = await postJson(app, '/mandates/propose', proposeBody())
    const { proposal_id } = (await create.json()) as { proposal_id: string }

    const res = await getJson(app, `/mandates/proposals/${proposal_id}`)
    expect(res.status).toBe(200)
    const json = (await res.json()) as {
      proposal: { id: string; status: string; summary: string; agent_pubkey_hex: string }
    }
    expect(json.proposal.id).toBe(proposal_id)
    expect(json.proposal.status).toBe('pending')
    expect(json.proposal.agent_pubkey_hex).toBe(AGENT_PUBKEY)
    expect(json.proposal.summary).toContain('₹5,000.00')
    expect(json.proposal.summary).toContain('example-com')
  })

  it('returns 404 PROPOSAL_NOT_FOUND for an unknown id', async () => {
    const { app } = makeTestApp()
    const res = await getJson(app, '/mandates/proposals/no-such-id')
    expect(res.status).toBe(404)
    expect(await res.json()).toMatchObject({ ok: false, error: 'PROPOSAL_NOT_FOUND' })
  })

  it('reports a proposal past its expires_at as "expired" without needing a sweep', async () => {
    const { app } = makeTestApp({
      scanStore: async () => fakeScanResult({ merchant_id: 'example-com' }),
    })
    await onboardExampleStore(app)
    const create = await postJson(
      app,
      '/mandates/propose',
      proposeBody({ expires_at: Math.floor(Date.now() / 1000) - 10 }),
    )
    const { proposal_id } = (await create.json()) as { proposal_id: string }

    const res = await getJson(app, `/mandates/proposals/${proposal_id}`)
    const json = (await res.json()) as { proposal: { status: string } }
    expect(json.proposal.status).toBe('expired')

    const pending = await getJson(app, '/mandates/proposals?status=pending')
    const pendingJson = (await pending.json()) as { proposals: { id: string }[] }
    expect(pendingJson.proposals.map((p) => p.id)).not.toContain(proposal_id)

    const expired = await getJson(app, '/mandates/proposals?status=expired')
    const expiredJson = (await expired.json()) as { proposals: { id: string }[] }
    expect(expiredJson.proposals.map((p) => p.id)).toContain(proposal_id)
  })
})

describe('POST /mandates/proposals/:id/consume', () => {
  it('requires the dashboard token', async () => {
    const { app } = makeTestApp({
      scanStore: async () => fakeScanResult({ merchant_id: 'example-com' }),
    })
    await onboardExampleStore(app)
    const create = await postJson(app, '/mandates/propose', proposeBody())
    const { proposal_id } = (await create.json()) as { proposal_id: string }

    const res = await postJson(app, `/mandates/proposals/${proposal_id}/consume`, {})
    expect(res.status).toBe(401)
  })

  it('flips a pending proposal to consumed, and is idempotent on a second call', async () => {
    const { app } = makeTestApp({
      scanStore: async () => fakeScanResult({ merchant_id: 'example-com' }),
    })
    await onboardExampleStore(app)
    const create = await postJson(app, '/mandates/propose', proposeBody())
    const { proposal_id } = (await create.json()) as { proposal_id: string }

    const first = await postJson(
      app,
      `/mandates/proposals/${proposal_id}/consume`,
      {},
      DASHBOARD_HEADERS,
    )
    expect(first.status).toBe(200)
    const firstJson = (await first.json()) as { proposal: { status: string } }
    expect(firstJson.proposal.status).toBe('consumed')

    const second = await postJson(
      app,
      `/mandates/proposals/${proposal_id}/consume`,
      {},
      DASHBOARD_HEADERS,
    )
    expect(second.status).toBe(200)
    const secondJson = (await second.json()) as { proposal: { status: string } }
    expect(secondJson.proposal.status).toBe('consumed')

    const getRes = await getJson(app, `/mandates/proposals/${proposal_id}`)
    const getJsonBody = (await getRes.json()) as { proposal: { status: string } }
    expect(getJsonBody.proposal.status).toBe('consumed')
  })

  it('returns 404 for an unknown id', async () => {
    const { app } = makeTestApp()
    const res = await postJson(app, '/mandates/proposals/no-such-id/consume', {}, DASHBOARD_HEADERS)
    expect(res.status).toBe(404)
  })
})
