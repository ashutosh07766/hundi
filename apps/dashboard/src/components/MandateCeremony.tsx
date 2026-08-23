import type { FormEvent } from 'react'
import { useState } from 'react'
import { useIdentity } from '../context/identity-context.js'
import { markExternalAgentKey, saveLocalAgentKey } from '../lib/agent-key.js'
import { mintCeremonyToken, registerMandate } from '../lib/api.js'
import { rupeesToPaise } from '../lib/format.js'
import type { SignedCeremony } from '../lib/intent.js'
import { buildSignedIntent } from '../lib/intent.js'
import { generateKeypair } from '../lib/signing.js'
import { SignatureIcon } from './icons.js'

function defaultExpiryLocal(hoursFromNow: number): string {
  const d = new Date(Date.now() + hoursFromNow * 60 * 60 * 1000)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function MandateCeremony() {
  const { human, dashboardToken, humanSign, humanCredential } = useIdentity()

  const [goal, setGoal] = useState('')
  const [ceilingRupees, setCeilingRupees] = useState('2000')
  const [thresholdRupees, setThresholdRupees] = useState('500')
  const [merchantsCsv, setMerchantsCsv] = useState('')
  const [expiryLocal, setExpiryLocal] = useState(() => defaultExpiryLocal(1))
  const [agentPubkeyHex, setAgentPubkeyHex] = useState('')

  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<{ ceremony: SignedCeremony; mandateId: string } | null>(null)
  /** Set only when the operator left the agent-key field blank and we minted an
   * ephemeral one — surfaced so it can be handed to a brain. Not persisted. */
  const [ephemeralAgentKey, setEphemeralAgentKey] = useState<{
    secretKeyHex: string
    publicKeyHex: string
  } | null>(null)

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setResult(null)
    setEphemeralAgentKey(null)

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

    // The intent attests a DISTINCT agent key as the cart signer — never the
    // human key (that collapse is the vulnerability this ceremony exists to
    // avoid). If the operator didn't paste the agent's pubkey, mint an ephemeral
    // agent keypair here and surface it below so it can be handed to a brain.
    let agentPubkey = agentPubkeyHex.trim()
    let mintedEphemeral: { secretKeyHex: string; publicKeyHex: string } | null = null
    if (!agentPubkey) {
      mintedEphemeral = generateKeypair()
      agentPubkey = mintedEphemeral.publicKeyHex
    }
    if (agentPubkey === human.publicKeyHex) {
      setError('The agent key must differ from the human key — they are separate parties.')
      return
    }

    setBusy(true)
    try {
      const ceremony = await buildSignedIntent(
        {
          goal,
          ceilingPaise: rupeesToPaise(Number(ceilingRupees)),
          approvalThresholdPaise: rupeesToPaise(Number(thresholdRupees)),
          merchants,
          expiresAt,
          agentPubkeyHex: agentPubkey,
        },
        humanSign,
        humanCredential(),
      )
      const ceremonyToken = await mintCeremonyToken(dashboardToken)
      const { mandateId } = await registerMandate(
        ceremony.intent,
        ceremony.credential,
        ceremonyToken,
      )
      setResult({ ceremony, mandateId })
      // Persist the AGENT key so "Run test purchase" can sign a cart with it later —
      // see agent-key.ts. Only the ephemeral (minted-here) key has a private half to
      // store; a pasted-in agent pubkey is held externally by definition.
      if (mintedEphemeral) {
        setEphemeralAgentKey(mintedEphemeral)
        saveLocalAgentKey(mandateId, mintedEphemeral)
      } else {
        markExternalAgentKey(mandateId)
      }
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
        <fieldset className="form-group">
          <legend className="form-group__legend">What is this mandate for</legend>
          <label className="field">
            <span>Goal</span>
            <input
              required
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
              placeholder="Restock office snacks"
            />
          </label>
        </fieldset>

        <fieldset className="form-group">
          <legend className="form-group__legend">Spending limits</legend>
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
          <p className="form-group__hint">
            <strong>Ceiling</strong> is the total the agent can ever spend under this mandate.{' '}
            <strong>Threshold</strong> is a per-purchase line — any single cart above it pauses and
            waits for your approval instead of settling automatically.
          </p>
        </fieldset>

        <fieldset className="form-group">
          <legend className="form-group__legend">Scope</legend>
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
            <span>Agent public key (hex)</span>
            <input
              value={agentPubkeyHex}
              onChange={(e) => setAgentPubkeyHex(e.target.value)}
              placeholder="Paste the agent's ed25519 pubkey — leave blank to mint an ephemeral one"
            />
            <small className="field__hint">
              The buyer agent's key, generated out-of-band. It signs carts; it can never approve or
              revoke. Leave blank and the dashboard mints a throwaway agent key to hand off.
            </small>
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
        </fieldset>

        <button type="submit" className="btn btn--primary btn--icon" disabled={busy}>
          <SignatureIcon />
          {busy ? 'Signing…' : 'Sign & register mandate'}
        </button>
      </form>

      {error && <div className="banner banner--error">{error}</div>}

      {ephemeralAgentKey && (
        <div className="banner banner--warning">
          <p>
            <strong>Give this to the agent.</strong> No agent key was provided, so an ephemeral one
            was minted. It's also saved in this browser (keyed to the mandate) so the "Run test
            purchase" button below can drive a purchase with it — a real agent process should get
            its own copy of the private key too.
          </p>
          <p>
            Agent public key: <code>{ephemeralAgentKey.publicKeyHex}</code>
          </p>
          <p>
            Agent private key: <code>{ephemeralAgentKey.secretKeyHex}</code>
          </p>
        </div>
      )}

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
