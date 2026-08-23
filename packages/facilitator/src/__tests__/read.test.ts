import { describe, expect, it } from 'vitest'
import { credentialFor, makeCart, makeIntent } from './fixtures.js'
import { getJson, makeTestApp, postJson, registerMandate } from './http-helpers.js'

describe('GET /settlements', () => {
  it('returns {ok:true, settlements:[]} against an empty db', async () => {
    const { app } = makeTestApp()
    const res = await getJson(app, '/settlements')
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json).toEqual({ ok: true, settlements: [] })
  })

  it('returns every settlement row with the contract fields, newest first', async () => {
    const { app } = makeTestApp()
    const { intent, agent } = makeIntent()
    await registerMandate(app, intent, credentialFor(agent))

    // Below-threshold cart auto-approves; above-threshold parks pending_approval —
    // gives two distinct states to filter on below.
    const belowCart = makeCart({
      agent,
      intent,
      items: [{ sku: 'sku-1', qty: 1, unit_price_paise: 50_000 }],
      overrides: { cartId: 'read-below-cart' },
    })
    const createRes = await postJson(
      app,
      '/settlements',
      { intent, cart: belowCart },
      { 'Idempotency-Key': 'read-idem-below' },
    )
    expect(createRes.status).toBe(202)
    const created = (await createRes.json()) as { settlement_id: string; state: string }

    const res = await getJson(app, '/settlements')
    expect(res.status).toBe(200)
    const json = (await res.json()) as { ok: true; settlements: unknown[] }
    expect(json.ok).toBe(true)
    expect(json.settlements).toHaveLength(1)
    expect(json.settlements[0]).toMatchObject({
      id: created.settlement_id,
      mandate_id: intent.mandateId,
      state: 'approved',
      amount_paise: 50_000,
      merchant_id: 'merchant-1',
      reject_reason: null,
    })
    const row = json.settlements[0] as {
      mandate_cart_hash_hex: string
      cart_json: string
      created_at: number
    }
    expect(typeof row.mandate_cart_hash_hex).toBe('string')
    expect(typeof row.created_at).toBe('number')
    expect(JSON.parse(row.cart_json)).toMatchObject({ cartId: 'read-below-cart' })
  })

  it('filters by ?state=', async () => {
    const { app } = makeTestApp()
    const { intent, agent } = makeIntent()
    await registerMandate(app, intent, credentialFor(agent))

    const aboveCart = makeCart({
      agent,
      intent,
      items: [{ sku: 'sku-1', qty: 1, unit_price_paise: 300_000 }],
      overrides: { cartId: 'read-above-cart' },
    })
    await postJson(
      app,
      '/settlements',
      { intent, cart: aboveCart },
      { 'Idempotency-Key': 'read-idem-above' },
    )

    const matching = await getJson(app, '/settlements?state=pending_approval')
    expect(matching.status).toBe(200)
    const matchingJson = (await matching.json()) as { ok: true; settlements: unknown[] }
    expect(matchingJson.settlements).toHaveLength(1)

    const nonMatching = await getJson(app, '/settlements?state=captured')
    expect(nonMatching.status).toBe(200)
    const nonMatchingJson = (await nonMatching.json()) as { ok: true; settlements: unknown[] }
    expect(nonMatchingJson.settlements).toEqual([])
  })

  it('rejects an unknown state with 400 INVALID_STATE', async () => {
    const { app } = makeTestApp()
    const res = await getJson(app, '/settlements?state=not_a_real_state')
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json).toEqual({ ok: false, error: 'INVALID_STATE' })
  })
})

describe('GET /mandates', () => {
  it('returns {ok:true, mandates:[]} against an empty db', async () => {
    const { app } = makeTestApp()
    const res = await getJson(app, '/mandates')
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json).toEqual({ ok: true, mandates: [] })
  })

  it('returns registered mandates with intent_json parseable and revoked_at null', async () => {
    const { app } = makeTestApp()
    const { intent, agent } = makeIntent()
    await registerMandate(app, intent, credentialFor(agent))

    const res = await getJson(app, '/mandates')
    expect(res.status).toBe(200)
    const json = (await res.json()) as { ok: true; mandates: unknown[] }
    expect(json.mandates).toHaveLength(1)
    const row = json.mandates[0] as {
      mandate_id: string
      intent_json: string
      revoked_at: number | null
      created_at: number
    }
    expect(row.mandate_id).toBe(intent.mandateId)
    expect(row.revoked_at).toBeNull()
    expect(typeof row.created_at).toBe('number')
    expect(JSON.parse(row.intent_json)).toMatchObject({ mandateId: intent.mandateId })
  })

  it('reports cumulative-wallet accounting: spent_paise, remaining_paise, and derived state', async () => {
    const { app, db } = makeTestApp()
    const { intent, agent } = makeIntent({ overrides: { ceiling_paise: 500_000 } })
    await registerMandate(app, intent, credentialFor(agent))

    const insertCaptured = (id: string, amount: number, hash: string) =>
      db
        .prepare(
          `INSERT INTO settlements (id, mandate_id, cart_json, mandate_cart_hash_hex, amount_paise, merchant_id, state)
           VALUES (?, ?, '{}', ?, ?, 'merchant-1', 'captured')`,
        )
        .run(id, intent.mandateId, hash, amount)

    // One ₹2,000 capture against a ₹5,000 ceiling → ₹3,000 left, still active.
    insertCaptured('s-1', 200_000, 'hash-1')
    let json = (await (await getJson(app, '/mandates')).json()) as {
      mandates: { spent_paise: number; remaining_paise: number; state: string }[]
    }
    expect(json.mandates[0]).toMatchObject({
      spent_paise: 200_000,
      remaining_paise: 300_000,
      state: 'active',
    })

    // A second capture drains the ceiling exactly → remaining 0, state consumed.
    insertCaptured('s-2', 300_000, 'hash-2')
    json = (await (await getJson(app, '/mandates')).json()) as {
      mandates: { spent_paise: number; remaining_paise: number; state: string }[]
    }
    expect(json.mandates[0]).toMatchObject({
      spent_paise: 500_000,
      remaining_paise: 0,
      state: 'consumed',
    })
  })
})

describe('GET /ledger', () => {
  it('returns {ok:true, events:[]} against an empty db', async () => {
    const { app } = makeTestApp()
    const res = await getJson(app, '/ledger')
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json).toEqual({ ok: true, events: [] })
  })

  it('returns events newest-first by seq with a parsed (not stringified) payload', async () => {
    const { app } = makeTestApp()
    const { intent: intentA, agent: agentA } = makeIntent()
    const { intent: intentB, agent: agentB } = makeIntent()
    await registerMandate(app, intentA, credentialFor(agentA))
    await registerMandate(app, intentB, credentialFor(agentB))

    const res = await getJson(app, '/ledger')
    expect(res.status).toBe(200)
    const json = (await res.json()) as {
      ok: true
      events: Array<{ seq: number; event_type: string; payload: unknown }>
    }
    expect(json.events.length).toBeGreaterThanOrEqual(2)

    const seqs = json.events.map((e) => e.seq)
    expect(seqs).toEqual([...seqs].sort((a, b) => b - a))

    const mandateEvent = json.events.find((e) => e.event_type === 'mandate_registered')
    expect(mandateEvent).toBeDefined()
    expect(typeof mandateEvent?.payload).toBe('object')
    expect(mandateEvent?.payload).not.toBeNull()
    expect(Array.isArray(mandateEvent?.payload)).toBe(false)
  })

  it('respects ?limit=', async () => {
    const { app } = makeTestApp()
    for (let i = 0; i < 5; i++) {
      const { intent, agent } = makeIntent()
      await registerMandate(app, intent, credentialFor(agent))
    }

    const res = await getJson(app, '/ledger?limit=2')
    expect(res.status).toBe(200)
    const json = (await res.json()) as { ok: true; events: unknown[] }
    expect(json.events).toHaveLength(2)
  })

  it('caps a limit above 1000 down to 1000', async () => {
    const { app } = makeTestApp()
    const { intent, agent } = makeIntent()
    await registerMandate(app, intent, credentialFor(agent))

    const res = await getJson(app, '/ledger?limit=5000')
    expect(res.status).toBe(200)
    // Only one event exists (mandate_registered) — the cap can't be observed by count
    // alone, so this asserts the request succeeds rather than erroring on an
    // out-of-range limit.
    const json = (await res.json()) as { ok: true; events: unknown[] }
    expect(json.ok).toBe(true)
    expect(json.events.length).toBeLessThanOrEqual(1000)
  })

  it('rejects a non-integer limit with 400 INVALID_LIMIT', async () => {
    const { app } = makeTestApp()
    const res = await getJson(app, '/ledger?limit=abc')
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json).toEqual({ ok: false, error: 'INVALID_LIMIT' })

    const decimalRes = await getJson(app, '/ledger?limit=12.5')
    expect(decimalRes.status).toBe(400)
    const decimalJson = await decimalRes.json()
    expect(decimalJson).toEqual({ ok: false, error: 'INVALID_LIMIT' })
  })
})

describe('GET /ledger/verify', () => {
  it('returns {ok:true, head, count} for a clean chain on an empty db, with 200', async () => {
    const { app } = makeTestApp()
    const res = await getJson(app, '/ledger/verify')
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json).toEqual({ ok: true, head: 'HUNDI_GENESIS', count: 0 })
  })

  it('returns {ok:true, count} matching the number of appended events', async () => {
    const { app } = makeTestApp()
    const { intent: intentA, agent: agentA } = makeIntent()
    const { intent: intentB, agent: agentB } = makeIntent()
    await registerMandate(app, intentA, credentialFor(agentA))
    await registerMandate(app, intentB, credentialFor(agentB))

    const res = await getJson(app, '/ledger/verify')
    expect(res.status).toBe(200)
    const json = (await res.json()) as { ok: true; head: string; count: number }
    expect(json.ok).toBe(true)
    expect(json.count).toBe(2)
    expect(typeof json.head).toBe('string')
  })

  it('returns {ok:false, brokenAtSeq} with HTTP 200 for a hand-corrupted chain', async () => {
    const { app, db } = makeTestApp()
    const { intent, agent } = makeIntent()
    await registerMandate(app, intent, credentialFor(agent))

    // Mirrors ledger.test.ts's tamper simulation: drop the append-only trigger just
    // long enough to rewrite one row, standing in for a process with direct file
    // access bypassing the DB-level guard.
    db.exec('DROP TRIGGER ledger_events_no_update')
    db.prepare('UPDATE ledger_events SET payload = ? WHERE seq = 1').run('{"tampered":true}')
    db.exec(
      `CREATE TRIGGER ledger_events_no_update BEFORE UPDATE ON ledger_events BEGIN SELECT RAISE(ABORT, 'ledger is append-only'); END;`,
    )

    const res = await getJson(app, '/ledger/verify')
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json).toEqual({ ok: false, brokenAtSeq: 1 })
  })
})
