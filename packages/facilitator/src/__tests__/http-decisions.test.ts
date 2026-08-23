import { describe, expect, it } from 'vitest'
import { credentialFor, makeCart, makeIntent, signCanonical } from './fixtures.js'
import { makeTestApp, postJson, registerMandate } from './http-helpers.js'

describe('POST /settlements/:id/decisions', () => {
  it('accepts a decision signed by the agent key and ledgers it', async () => {
    const { app, db } = makeTestApp()
    const { intent, agent } = makeIntent()
    await registerMandate(app, intent, credentialFor(agent))
    const cart = makeCart({
      agent,
      intent,
      items: [{ sku: 'sku-1', qty: 1, unit_price_paise: 50_000 }],
      overrides: { cartId: 'decisions-cart' },
    })
    const settleRes = await postJson(
      app,
      '/settlements',
      { intent, cart },
      { 'Idempotency-Key': 'idem-decisions' },
    )
    const { settlement_id: settlementId } = (await settleRes.json()) as { settlement_id: string }

    const payload = { note: 'reviewed cart before checkout' }
    const sig = signCanonical(agent.privateKey, payload)

    const res = await postJson(app, `/settlements/${settlementId}/decisions`, {
      payload,
      signature_hex: sig.signature_hex,
    })
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json).toMatchObject({ ok: true })

    const ledgerRow = db
      .prepare(
        "SELECT actor, payload FROM ledger_events WHERE settlement_id = ? AND event_type = 'agent_decision'",
      )
      .get(settlementId) as { actor: string; payload: string } | undefined
    expect(ledgerRow).toBeDefined()
    expect(ledgerRow?.actor).toBe(`agent:${agent.publicKeyHex.slice(0, 8)}`)
    expect(JSON.parse(ledgerRow?.payload ?? '{}')).toEqual(payload)
  })

  it('rejects a decision with an invalid signature with 401 AGENT_SIG_INVALID', async () => {
    const { app } = makeTestApp()
    const { intent, agent } = makeIntent()
    await registerMandate(app, intent, credentialFor(agent))
    const cart = makeCart({
      agent,
      intent,
      items: [{ sku: 'sku-1', qty: 1, unit_price_paise: 50_000 }],
      overrides: { cartId: 'decisions-cart-bad-sig' },
    })
    const settleRes = await postJson(
      app,
      '/settlements',
      { intent, cart },
      { 'Idempotency-Key': 'idem-decisions-bad' },
    )
    const { settlement_id: settlementId } = (await settleRes.json()) as { settlement_id: string }

    const res = await postJson(app, `/settlements/${settlementId}/decisions`, {
      payload: { note: 'forged' },
      signature_hex: '00'.repeat(64),
    })
    expect(res.status).toBe(401)
    const json = await res.json()
    expect(json).toMatchObject({ ok: false, error: 'AGENT_SIG_INVALID' })
  })
})
