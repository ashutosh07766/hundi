import { describe, expect, it } from 'vitest'
import { credentialFor, makeCart, makeIntent, signCanonical } from './fixtures.js'
import { makeTestApp, postJson, registerMandate } from './http-helpers.js'

describe('POST /revoke', () => {
  it('revokes a mandate on a valid signature, after which /verify reports MANDATE_REVOKED', async () => {
    const { app } = makeTestApp()
    const { intent, agent } = makeIntent()
    await registerMandate(app, intent, credentialFor(agent))

    const sig = signCanonical(agent.privateKey, { mandateId: intent.mandateId, action: 'revoke' })
    const revokeRes = await postJson(app, '/revoke', { mandateId: intent.mandateId, sig })
    expect(revokeRes.status).toBe(200)
    const revokeJson = await revokeRes.json()
    expect(revokeJson).toMatchObject({ ok: true, mandateId: intent.mandateId })

    const cart = makeCart({ agent, intent })
    const verifyRes = await postJson(app, '/verify', { intent, cart })
    expect(verifyRes.status).toBe(200)
    const verifyJson = await verifyRes.json()
    expect(verifyJson).toMatchObject({ ok: false, error: 'MANDATE_REVOKED' })
  })
})
