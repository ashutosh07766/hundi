// Route spike probe 3/3: is there any direct signal of Route enablement
// state for this account, independent of attempting a real create/transfer?
// Razorpay has no documented "features" or "capabilities" endpoint, so this
// probe is deliberately a grab-bag of read-only calls that might leak the
// signal (a list endpoint that 200s with an empty array vs. one that 4xxs
// naming the feature are very different answers) plus a summary that
// restates whatever probes 1 and 2 already found — the error bodies from
// those two ARE the primary enablement signal for this spike, this probe
// just centralizes the read-only cross-checks.

import { loadEnv, logStep, rzpFetch } from '../rail-matrix/lib.ts'

loadEnv()

const ROUTE_V2_BASE = 'https://api.razorpay.com/v2'

async function tryListLinkedAccountsV2() {
  const res = await rzpFetch('/accounts', {}, ROUTE_V2_BASE)
  logStep('list_linked_accounts_v2', res.ok, res.body)
  return res
}

async function tryListLinkedAccountsLegacy() {
  const res = await rzpFetch('/beta/accounts')
  logStep('list_linked_accounts_legacy_beta', res.ok, res.body)
  return res
}

async function tryListTransfers() {
  // GET /transfers is documented for accounts with Route already active —
  // an empty-but-200 response here would suggest Route is at least
  // reachable even if create/transfer writes are separately gated.
  const res = await rzpFetch('/transfers?count=5')
  logStep('list_transfers', res.ok, res.body)
  return res
}

function classify(status: number, body: unknown): 'enablement_gated' | 'not_found' | 'other_error' | 'reachable' {
  if (status >= 200 && status < 300) return 'reachable'
  if (status === 404) return 'not_found'
  const text = JSON.stringify(body).toLowerCase()
  if (
    text.includes('not enabled') ||
    text.includes('route') ||
    text.includes('feature') ||
    text.includes('not activated') ||
    text.includes('unauthorized')
  ) {
    return 'enablement_gated'
  }
  return 'other_error'
}

async function main() {
  const listV2 = await tryListLinkedAccountsV2()
  const listLegacy = listV2.status === 404 ? await tryListLinkedAccountsLegacy() : undefined
  const listTransfers = await tryListTransfers()

  const summary = {
    list_linked_accounts_v2: { status: listV2.status, classification: classify(listV2.status, listV2.body) },
    list_linked_accounts_legacy_beta: listLegacy
      ? { status: listLegacy.status, classification: classify(listLegacy.status, listLegacy.body) }
      : undefined,
    list_transfers: { status: listTransfers.status, classification: classify(listTransfers.status, listTransfers.body) },
  }

  logStep('final', true, { verdict: 'STATUS_SUMMARY', summary })
  process.exit(0)
}

main().catch((err) => {
  logStep('fatal', false, { message: err instanceof Error ? err.message : String(err) })
  process.exit(1)
})
