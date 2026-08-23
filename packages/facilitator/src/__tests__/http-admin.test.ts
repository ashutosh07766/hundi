import { describe, expect, it } from 'vitest'
import { makeTestApp, postJson, TEST_ENV } from './http-helpers.js'

describe('POST /admin/merchants', () => {
  it('rejects requests without the admin token', async () => {
    const { app } = makeTestApp()
    const res = await postJson(app, '/admin/merchants', {
      merchant_id: 'merchant-noauth',
      name: 'No Auth Merchant',
      config: {},
    })
    expect(res.status).toBe(401)
    const json = await res.json()
    expect(json).toMatchObject({ ok: false, error: 'UNAUTHORIZED' })
  })

  it('is create-only: a second registration of the same merchant_id returns 409', async () => {
    const { app } = makeTestApp()
    const body = { merchant_id: 'merchant-dup', name: 'Dup Merchant', config: {} }
    const headers = { 'x-hundi-admin-token': TEST_ENV.ADMIN_TOKEN }

    const first = await postJson(app, '/admin/merchants', body, headers)
    expect(first.status).toBe(201)

    const second = await postJson(app, '/admin/merchants', body, headers)
    expect(second.status).toBe(409)
    const json = await second.json()
    expect(json).toMatchObject({ ok: false, error: 'MERCHANT_EXISTS' })
  })
})
