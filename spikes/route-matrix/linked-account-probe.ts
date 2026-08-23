// Route spike probe 1/3: can this TEST-mode account create a Route linked
// account at all? Route requires Razorpay-side enablement (KYC review on the
// parent account) independent of API correctness — a 4xx here that names
// "not enabled" / "feature" / "route" is the enablement wall itself, not a
// malformed-request bug, and it IS the answer for this probe.
//
// Tries the current Accounts API shape (`POST /v2/accounts`) first, since
// that's what Razorpay's public Route docs describe as of this writing. On
// a 404 (route doesn't exist for this account/host at all, as opposed to a
// 4xx business error) falls back to the older `POST /v1/beta/accounts`
// shape some TEST-mode accounts still resolve — undocumented in the current
// public reference, kept here only as a shape-of-degradation probe.

import { loadEnv, logStep, rzpFetch } from '../rail-matrix/lib.ts'

loadEnv()

const ROUTE_V2_BASE = 'https://api.razorpay.com/v2'

interface LinkedAccountResponse {
  id?: string
  email?: string
  phone?: string
  type?: string
  status?: string
  error?: { code?: string; description?: string; reason?: string; field?: string; [key: string]: unknown }
  [key: string]: unknown
}

function linkedAccountPayload() {
  const suffix = Date.now()
  return {
    email: `route-spike-${suffix}@example.com`,
    phone: '9000090000',
    type: 'route',
    reference_id: `route-spike-${suffix}`,
    legal_business_name: 'Hundi Route Spike Merchant',
    business_type: 'individual',
    contact_name: 'Hundi Route Spike',
    profile: {
      category: 'ecommerce',
      subcategory: 'ecommerce',
      addresses: {
        registered: {
          street1: '507, Koramangala 1st Block',
          street2: 'MG Road',
          city: 'Bengaluru',
          state: 'KARNATAKA',
          postal_code: '560034',
          country: 'IN',
        },
      },
    },
  }
}

async function tryV2Create() {
  const res = await rzpFetch<LinkedAccountResponse>(
    '/accounts',
    { method: 'POST', body: JSON.stringify(linkedAccountPayload()) },
    ROUTE_V2_BASE,
  )
  logStep('create_linked_account_v2', res.ok, res.body)
  return res
}

async function tryLegacyBetaCreate() {
  const res = await rzpFetch<LinkedAccountResponse>('/beta/accounts', {
    method: 'POST',
    body: JSON.stringify(linkedAccountPayload()),
  })
  logStep('create_linked_account_legacy_beta', res.ok, res.body)
  return res
}

async function main() {
  const v2 = await tryV2Create()

  if (v2.ok) {
    const body = v2.body as LinkedAccountResponse
    logStep('final', true, { verdict: 'LINKED_ACCOUNT_CREATED_V2', accountId: body.id })
    // Print the account id on its own line so transfer-probe.ts can be
    // chained manually: `tsx transfer-probe.ts <accountId>`.
    console.log(`ROUTE_ACCOUNT_ID=${body.id}`)
    process.exit(0)
  }

  // A 404 on the v2 host means the route literally isn't resolvable for
  // this account (not merely a rejected business request) — worth trying
  // the legacy shape. Any other status (400/401/403/422 etc.) is itself
  // the enablement/validation signal; no fallback needed.
  if (v2.status === 404) {
    logStep('v2_404_trying_legacy_beta', true, { status: v2.status })
    const legacy = await tryLegacyBetaCreate()

    if (legacy.ok) {
      const body = legacy.body as LinkedAccountResponse
      logStep('final', true, { verdict: 'LINKED_ACCOUNT_CREATED_LEGACY_BETA', accountId: body.id })
      console.log(`ROUTE_ACCOUNT_ID=${body.id}`)
      process.exit(0)
    }

    logStep('final', false, {
      verdict: 'GATED',
      v2Status: v2.status,
      v2Body: v2.body,
      legacyStatus: legacy.status,
      legacyBody: legacy.body,
    })
    process.exit(1)
  }

  logStep('final', false, { verdict: 'GATED', v2Status: v2.status, v2Body: v2.body })
  process.exit(1)
}

main().catch((err) => {
  logStep('fatal', false, { message: err instanceof Error ? err.message : String(err) })
  process.exit(1)
})
