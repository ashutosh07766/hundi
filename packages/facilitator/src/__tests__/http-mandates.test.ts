import { describe, expect, it } from 'vitest'
import { credentialFor, makeIntent } from './fixtures.js'
import { makeTestApp, mintCeremonyToken, postJson, TEST_ENV } from './http-helpers.js'

describe('POST /ceremony-tokens', () => {
  it('requires the dashboard token', async () => {
    const { app } = makeTestApp()
    const res = await postJson(app, '/ceremony-tokens', {})
    expect(res.status).toBe(401)
    const json = await res.json()
    expect(json).toMatchObject({ ok: false, error: 'UNAUTHORIZED' })
  })

  it('mints a token when the dashboard token header is correct', async () => {
    const { app } = makeTestApp()
    const res = await postJson(
      app,
      '/ceremony-tokens',
      {},
      { 'x-hundi-dashboard-token': TEST_ENV.DASHBOARD_TOKEN },
    )
    expect(res.status).toBe(201)
    const json = (await res.json()) as { ok: boolean; ceremonyToken: string }
    expect(json.ok).toBe(true)
    expect(json.ceremonyToken).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('POST /mandates', () => {
  it('registers a mandate with a fresh ceremony token', async () => {
    const { app } = makeTestApp()
    const { intent, agent } = makeIntent()
    const ceremonyToken = await mintCeremonyToken(app)

    const res = await postJson(app, '/mandates', {
      intent,
      credential: credentialFor(agent),
      ceremonyToken,
    })
    expect(res.status).toBe(201)
    const json = (await res.json()) as { ok: boolean; mandateId: string; intent_hash_hex: string }
    expect(json.ok).toBe(true)
    expect(json.mandateId).toBe(intent.mandateId)
    expect(json.intent_hash_hex).toMatch(/^[0-9a-f]{64}$/)
  })

  it('rejects a second use of the same ceremony token with 401 TOKEN_INVALID', async () => {
    const { app } = makeTestApp()
    const ceremonyToken = await mintCeremonyToken(app)

    const { intent: intent1, agent: agent1 } = makeIntent()
    const first = await postJson(app, '/mandates', {
      intent: intent1,
      credential: credentialFor(agent1),
      ceremonyToken,
    })
    expect(first.status).toBe(201)

    const { intent: intent2, agent: agent2 } = makeIntent()
    const second = await postJson(app, '/mandates', {
      intent: intent2,
      credential: credentialFor(agent2),
      ceremonyToken,
    })
    expect(second.status).toBe(401)
    const json = await second.json()
    expect(json).toMatchObject({ ok: false, error: 'TOKEN_INVALID' })
  })

  it('rejects registration with no valid ceremony token (401)', async () => {
    const { app } = makeTestApp()
    const { intent, agent } = makeIntent()

    const res = await postJson(app, '/mandates', {
      intent,
      credential: credentialFor(agent),
      ceremonyToken: 'not-a-real-token',
    })
    expect(res.status).toBe(401)
    const json = await res.json()
    expect(json).toMatchObject({ ok: false, error: 'TOKEN_INVALID' })
  })

  it('rejects a duplicate mandateId with 409 MANDATE_EXISTS', async () => {
    const { app } = makeTestApp()
    const { intent, agent } = makeIntent()

    const firstToken = await mintCeremonyToken(app)
    const first = await postJson(app, '/mandates', {
      intent,
      credential: credentialFor(agent),
      ceremonyToken: firstToken,
    })
    expect(first.status).toBe(201)

    const secondToken = await mintCeremonyToken(app)
    const second = await postJson(app, '/mandates', {
      intent,
      credential: credentialFor(agent),
      ceremonyToken: secondToken,
    })
    expect(second.status).toBe(409)
    const json = await second.json()
    expect(json).toMatchObject({ ok: false, error: 'MANDATE_EXISTS' })
  })
})
