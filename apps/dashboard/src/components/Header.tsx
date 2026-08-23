import { useState } from 'react'
import { useIdentity } from '../context/identity-context.js'
import { FACILITATOR_URL } from '../lib/config.js'
import type { SignerMode } from '../lib/human-signer.js'
import { ChevronDownIcon, GearIcon } from './icons.js'

function truncate(value: string): string {
  return `${value.slice(0, 12)}…${value.slice(-8)}`
}

/**
 * Product header + the collapsible technical-config disclosure. The
 * connection settings (facilitator URL, signer mode, keys, dashboard token)
 * stay fully functional here — they're just tucked behind a closed
 * "Settings" panel instead of always occupying the top of the screen, so the
 * default view reads as a product rather than a debug console. Which store
 * catalog gets shopped is scoped per-mandate (see the Stores tab + mandate
 * ceremony dropdown), not a global connection setting.
 */
export function Header() {
  const {
    human,
    resetHuman,
    dashboardToken,
    setDashboardToken,
    signerMode,
    passkey,
    passkeyNotice,
    selectSignerMode,
  } = useIdentity()
  const [tokenDraft, setTokenDraft] = useState(dashboardToken)
  const [switchingTo, setSwitchingTo] = useState<SignerMode | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)

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
      <header className="app-header">
        <div className="app-header__row">
          <div className="brand">
            <span className="brand__mark">Hundi</span>
            <p className="brand__tagline">
              A trust envelope for AI-agent payments — every rupee explainable, bounded, gated,
              audited.
            </p>
          </div>

          <button
            type="button"
            className="settings-toggle"
            aria-expanded={settingsOpen}
            aria-controls="settings-panel"
            onClick={() => setSettingsOpen((o) => !o)}
          >
            <GearIcon />
            <span>Settings</span>
            <ChevronDownIcon
              className={`settings-toggle__chevron ${settingsOpen ? 'settings-toggle__chevron--open' : ''}`}
            />
          </button>
        </div>
      </header>

      <div
        id="settings-panel"
        className={`settings-panel ${settingsOpen ? 'settings-panel--open' : ''}`}
      >
        <div className="settings-panel__inner">
          <div className="settings-panel__content">
            <p className="settings-panel__hint">
              Connection and signing configuration. These values are local to this browser and are
              not part of any mandate's authority.
            </p>

            <div className="settings-grid">
              <div className="settings-field">
                <span className="settings-field__label">Facilitator</span>
                <code className="settings-field__value">{FACILITATOR_URL}</code>
              </div>

              <form
                className="settings-field"
                onSubmit={(e) => {
                  e.preventDefault()
                  setDashboardToken(tokenDraft)
                }}
              >
                <span className="settings-field__label">Dashboard token</span>
                <div className="settings-field__row">
                  <input
                    className="settings-field__input"
                    type="password"
                    value={tokenDraft}
                    placeholder="x-hundi-dashboard-token"
                    onChange={(e) => setTokenDraft(e.target.value)}
                  />
                  <button type="submit" className="btn btn--ghost btn--small">
                    Save
                  </button>
                </div>
              </form>

              <div className="settings-field">
                <span className="settings-field__label">Signer</span>
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
                <div className="settings-field">
                  <span className="settings-field__label">Human key</span>
                  <div className="settings-field__row">
                    <code className="settings-field__value" title={human.publicKeyHex}>
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
                </div>
              )}

              {signerMode === 'passkey' && passkey && (
                <div className="settings-field">
                  <span className="settings-field__label">Passkey credential</span>
                  <code className="settings-field__value" title={passkey.credentialId}>
                    {truncate(passkey.credentialId)}
                  </code>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {passkeyNotice && (
        <div className="banner banner--warning app-header__notice">{passkeyNotice}</div>
      )}
    </>
  )
}
