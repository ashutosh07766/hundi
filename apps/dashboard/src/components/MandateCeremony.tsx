import type { FormEvent } from 'react'
import { useState } from 'react'
import { useIdentity } from '../context/identity-context.js'
import { mintCeremonyToken, registerMandate } from '../lib/api.js'
import { rupeesToPaise } from '../lib/format.js'
import type { SignedCeremony } from '../lib/intent.js'
import { buildSignedIntent } from '../lib/intent.js'

function defaultExpiryLocal(hoursFromNow: number): string {
  const d = new Date(Date.now() + hoursFromNow * 60 * 60 * 1000)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function MandateCeremony() {
  const { human, dashboardToken } = useIdentity()

  const [goal, setGoal] = useState('')
  const [ceilingRupees, setCeilingRupees] = useState('2000')
  const [thresholdRupees, setThresholdRupees] = useState('500')
  const [merchantsCsv, setMerchantsCsv] = useState('')
  const [expiryLocal, setExpiryLocal] = useState(() => defaultExpiryLocal(1))

  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<{ ceremony: SignedCeremony; mandateId: string } | null>(null)

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setResult(null)

    if (!dashboardToken) {
      setError('Set the dashboard token above before running the ceremony.')
      return
    }
    const merchants = merchantsCsv
      .split(',')
      .map((m) => m.trim())
      .filter(Boolean)
    if (merchants.length === 0) {
      setError('At least one merchant is required.')
      return
    }
    const expiresAt = Math.floor(new Date(expiryLocal).getTime() / 1000)
    if (!Number.isFinite(expiresAt)) {
      setError('Invalid expiry.')
      return
    }

    setBusy(true)
    try {
      const ceremony = buildSignedIntent(
        {
          goal,
          ceilingPaise: rupeesToPaise(Number(ceilingRupees)),
          approvalThresholdPaise: rupeesToPaise(Number(thresholdRupees)),
          merchants,
          expiresAt,
        },
        human,
      )
      const ceremonyToken = await mintCeremonyToken(dashboardToken)
      const { mandateId } = await registerMandate(
        ceremony.intent,
        ceremony.credential,
        ceremonyToken,
      )
      setResult({ ceremony, mandateId })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="panel">
      <h2 className="panel__title">Mandate ceremony</h2>
      <p className="panel__hint">
        Sign a new intent mandate on-screen as the human. The agent authorized by this mandate can
        spend up to the ceiling, and must route anything above the approval threshold back here for
        a decision.
      </p>

      <form className="form" onSubmit={handleSubmit}>
        <label className="field">
          <span>Goal</span>
          <input
            required
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            placeholder="Restock office snacks"
          />
        </label>

        <div className="field-row">
          <label className="field">
            <span>Ceiling (₹)</span>
            <input
              required
              type="number"
              min="1"
              step="1"
              value={ceilingRupees}
              onChange={(e) => setCeilingRupees(e.target.value)}
            />
          </label>
          <label className="field">
            <span>Approval threshold (₹)</span>
            <input
              required
              type="number"
              min="0"
              step="1"
              value={thresholdRupees}
              onChange={(e) => setThresholdRupees(e.target.value)}
            />
          </label>
        </div>

        <label className="field">
          <span>Merchants (comma-separated)</span>
          <input
            required
            value={merchantsCsv}
            onChange={(e) => setMerchantsCsv(e.target.value)}
            placeholder="merchant-1, merchant-2"
          />
        </label>

        <label className="field">
          <span>Expires</span>
          <input
            required
            type="datetime-local"
            value={expiryLocal}
            onChange={(e) => setExpiryLocal(e.target.value)}
          />
        </label>

        <button type="submit" className="btn btn--primary" disabled={busy}>
          {busy ? 'Signing…' : 'Sign & register mandate'}
        </button>
      </form>

      {error && <div className="banner banner--error">{error}</div>}

      {result && (
        <div className="banner banner--success">
          <p>
            Mandate <code>{result.mandateId}</code> registered.
          </p>
          <pre className="json-block">{JSON.stringify(result.ceremony.intent, null, 2)}</pre>
        </div>
      )}
    </section>
  )
}
