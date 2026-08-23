import type { FormEvent } from 'react'
import { useState } from 'react'
import { useIdentity } from '../context/identity-context.js'
import { usePolling } from '../hooks/use-polling.js'
import { FACILITATOR_URL } from '../lib/config.js'
import type { OnboardStoreResult } from '../lib/stores.js'
import { listStores, onboardStore } from '../lib/stores.js'
import { LinkIcon } from './icons.js'

export function Stores() {
  const { dashboardToken } = useIdentity()
  const {
    data: stores,
    error: pollError,
    loading,
  } = usePolling(() => listStores(FACILITATOR_URL), 4000)

  const [urlDraft, setUrlDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<OnboardStoreResult | null>(null)

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setResult(null)

    if (!dashboardToken) {
      setError('Set the dashboard token in Settings before onboarding a store.')
      return
    }

    setBusy(true)
    try {
      setResult(await onboardStore(FACILITATOR_URL, dashboardToken, urlDraft.trim()))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const rows = stores ?? []

  return (
    <>
      <section className="panel">
        <h2 className="panel__title">Onboard a store</h2>
        <p className="panel__hint">
          Paste a real store's URL. Hundi scans its product pages for schema.org markup and makes it
          shoppable from a mandate — no admin token, no terminal. Payments still settle on Hundi's
          Razorpay TEST account, so this proves the trust flow against a real catalog without moving
          real money to the merchant.
        </p>

        <form className="form" onSubmit={handleSubmit}>
          <label className="field">
            <span>Store URL</span>
            <input
              required
              type="url"
              value={urlDraft}
              onChange={(e) => setUrlDraft(e.target.value)}
              placeholder="https://www.lifelongindiaonline.com"
            />
            <small className="field__hint">
              Try lifelongindiaonline.com — a real store to test with.
            </small>
          </label>

          <button type="submit" className="btn btn--primary btn--icon" disabled={busy}>
            <LinkIcon />
            {busy ? 'Scanning…' : 'Onboard store'}
          </button>
        </form>

        {error && <div className="banner banner--error">{error}</div>}

        {result && result.ok && (
          <div className="banner banner--success">
            <p>
              <strong>{result.name}</strong> onboarded as <code>{result.merchant_id}</code> —{' '}
              {result.product_count} product{result.product_count === 1 ? '' : 's'} found.
            </p>
            {result.sample.length > 0 && (
              <ul>
                {result.sample.map((title) => (
                  <li key={title}>{title}</li>
                ))}
              </ul>
            )}
          </div>
        )}

        {result && !result.ok && (
          <div className="banner banner--error">
            {result.error === 'NO_PRODUCTS'
              ? "No usable products found — this store doesn't expose schema.org product markup Hundi can read."
              : `Scan failed: ${result.detail}`}
          </div>
        )}
      </section>

      <section className="panel">
        <h2 className="panel__title">Shoppable stores</h2>
        <p className="panel__hint">
          Every store a mandate can target — the built-in demo store plus anything onboarded above.
          Pick one from the dropdown in Mandate ceremony to scope a new mandate to it.
        </p>

        {pollError && <div className="banner banner--error">Poll failed: {pollError}</div>}
        {loading && rows.length === 0 && <p className="panel__empty">Loading…</p>}
        {!loading && rows.length === 0 && !pollError && (
          <p className="panel__empty">No stores onboarded yet.</p>
        )}

        <div className="card-list">
          {rows.map((store) => (
            <article className="card" key={store.merchant_id}>
              <div className="card__row">
                <h3>{store.name}</h3>
                <span className="pill pill--ok">
                  {store.product_count} product{store.product_count === 1 ? '' : 's'}
                </span>
              </div>
              <div className="card__row card__row--muted">
                <code className="hash">{store.merchant_id}</code>
              </div>
              {store.source_url && (
                <div className="card__row card__row--muted">
                  <span>{store.source_url}</span>
                </div>
              )}
            </article>
          ))}
        </div>
      </section>
    </>
  )
}
