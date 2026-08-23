import { useState } from 'react'
import { useIdentity } from '../context/identity-context.js'
import { FACILITATOR_URL } from '../lib/config.js'
import type { SignerMode } from '../lib/human-signer.js'

function truncate(value: string): string {
  return `${value.slice(0, 12)}…${value.slice(-8)}`
}

export function IdentityBar() {
  const {
    human,
    resetHuman,
    dashboardToken,
    setDashboardToken,
    storeUrl,
    setStoreUrl,
    signerMode,
    passkey,
    passkeyNotice,
    selectSignerMode,
  } = useIdentity()
  const [tokenDraft, setTokenDraft] = useState(dashboardToken)
  const [storeDraft, setStoreDraft] = useState(storeUrl)
  const [switchingTo, setSwitchingTo] = useState<SignerMode | null>(null)

  async function handleModeSelect(mode: SignerMode) {
    if (mode === signerMode || switchingTo) return
    setSwitchingTo(mode)
    try {
      await selectSignerMode(mode)
    } finally {
      setSwitchingTo(null)
    }
  }

  return (
    <>
      <header className="identity-bar">
        <div className="identity-bar__brand">
          <span className="identity-bar__mark">Hundi</span>
          <span className="identity-bar__subtitle">Human Console</span>
        </div>

        <div className="identity-bar__field">
          <span className="identity-bar__label">Facilitator</span>
          <code className="identity-bar__value">{FACILITATOR_URL}</code>
        </div>

        <form
          className="identity-bar__field"
          onSubmit={(e) => {
            e.preventDefault()
            setStoreUrl(storeDraft)
          }}
        >
          <span className="identity-bar__label">Store</span>
          <input
            className="identity-bar__input"
            type="text"
            value={storeDraft}
            placeholder="http://127.0.0.1:8791"
            onChange={(e) => setStoreDraft(e.target.value)}
          />
          <button type="submit" className="btn btn--ghost btn--small">
            Save
          </button>
        </form>

        <div className="identity-bar__field">
          <span className="identity-bar__label">Signer</span>
          <div className="signer-toggle">
            <button
              type="button"
              aria-pressed={signerMode === 'ed25519'}
              className={`btn btn--ghost btn--small ${signerMode === 'ed25519' ? 'btn--active' : ''}`}
              disabled={switchingTo !== null}
              onClick={() => handleModeSelect('ed25519')}
            >
              Local key (ed25519)
            </button>
            <button
              type="button"
              aria-pressed={signerMode === 'passkey'}
              className={`btn btn--ghost btn--small ${signerMode === 'passkey' ? 'btn--active' : ''}`}
              disabled={switchingTo !== null}
              onClick={() => handleModeSelect('passkey')}
            >
              {switchingTo === 'passkey' ? 'Waiting for passkey…' : 'Passkey (WebAuthn)'}
            </button>
          </div>
        </div>

        {signerMode === 'ed25519' && (
          <div className="identity-bar__field">
            <span className="identity-bar__label">Human key</span>
            <code className="identity-bar__value" title={human.publicKeyHex}>
              {truncate(human.publicKeyHex)}
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
        )}

        {signerMode === 'passkey' && passkey && (
          <div className="identity-bar__field">
            <span className="identity-bar__label">Passkey credential</span>
            <code className="identity-bar__value" title={passkey.credentialId}>
              {truncate(passkey.credentialId)}
            </code>
          </div>
        )}

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

      {passkeyNotice && (
        <div className="banner banner--warning identity-bar__notice">{passkeyNotice}</div>
      )}
    </>
  )
}
