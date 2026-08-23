import { useState } from 'react'
import { useIdentity } from '../context/identity-context.js'
import { FACILITATOR_URL } from '../lib/config.js'

function truncateHex(hex: string): string {
  return `${hex.slice(0, 12)}…${hex.slice(-8)}`
}

export function IdentityBar() {
  const { human, resetHuman, dashboardToken, setDashboardToken } = useIdentity()
  const [tokenDraft, setTokenDraft] = useState(dashboardToken)

  return (
    <header className="identity-bar">
      <div className="identity-bar__brand">
        <span className="identity-bar__mark">Hundi</span>
        <span className="identity-bar__subtitle">Human Console</span>
      </div>

      <div className="identity-bar__field">
        <span className="identity-bar__label">Facilitator</span>
        <code className="identity-bar__value">{FACILITATOR_URL}</code>
      </div>

      <div className="identity-bar__field">
        <span className="identity-bar__label">Human key</span>
        <code className="identity-bar__value" title={human.publicKeyHex}>
          {truncateHex(human.publicKeyHex)}
        </code>
        <button
          type="button"
          className="btn btn--ghost btn--small"
          onClick={() => {
            if (
              confirm(
                'Reset the human identity? Mandates signed under the old key can no longer be approved or revoked from this console.',
              )
            ) {
              resetHuman()
            }
          }}
        >
          Reset
        </button>
      </div>

      <form
        className="identity-bar__field"
        onSubmit={(e) => {
          e.preventDefault()
          setDashboardToken(tokenDraft)
        }}
      >
        <span className="identity-bar__label">Dashboard token</span>
        <input
          className="identity-bar__input"
          type="password"
          value={tokenDraft}
          placeholder="x-hundi-dashboard-token"
          onChange={(e) => setTokenDraft(e.target.value)}
        />
        <button type="submit" className="btn btn--ghost btn--small">
          Save
        </button>
      </form>
    </header>
  )
}
