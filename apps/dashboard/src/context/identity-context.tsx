/**
 * The dashboard's own signing identity: "the human" who mints mandates and
 * decides approvals/revocations, plus the dashboard token that gates
 * ceremony-token minting. The human identity has two possible backings —
 * an Ed25519 keypair (default, see signing.ts) or a WebAuthn passkey
 * (opt-in, see webauthn.ts) — selected by `signerMode` and dispatched
 * through `human-signer.ts`'s pure `humanSign`/`resolveHumanCredential`.
 * Everything here is localStorage-backed so a page reload doesn't orphan
 * mandates already registered under the current key: the Ed25519 keypair
 * auto-generates on first run, the passkey identity persists once
 * registered but `signerMode` always boots back to `'ed25519'` — the
 * passkey is opt-in every session, never a silent default.
 */

import type { Credential, SigEnvelope } from '@hundi/core'
import type { ReactNode } from 'react'
import { createContext, useContext, useMemo, useState } from 'react'
import {
  getDashboardToken,
  getStoreUrl,
  setDashboardToken as persistDashboardToken,
  setStoreUrl as persistStoreUrl,
} from '../lib/config.js'
import type { HumanIdentity, SignerMode } from '../lib/human-signer.js'
import { humanSign as dispatchHumanSign, resolveHumanCredential } from '../lib/human-signer.js'
import type { HumanKeypair } from '../lib/signing.js'
import { loadOrCreateHumanKeypair, resetHumanKeypair } from '../lib/signing.js'
import type { PasskeyIdentity } from '../lib/webauthn.js'
import { isPasskeyCapable, registerPasskey } from '../lib/webauthn.js'

const PASSKEY_STORAGE_KEY = 'hundi.passkeyIdentity'

function loadStoredPasskey(): PasskeyIdentity | null {
  const raw = localStorage.getItem(PASSKEY_STORAGE_KEY)
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as PasskeyIdentity
    if (parsed.credentialId && parsed.publicKey_jwk) return parsed
  } catch {
    // Corrupt storage reads as "no passkey registered yet," not a crash.
  }
  return null
}

function persistPasskey(identity: PasskeyIdentity): void {
  localStorage.setItem(PASSKEY_STORAGE_KEY, JSON.stringify(identity))
}

type IdentityContextValue = {
  human: HumanKeypair
  resetHuman: () => void
  dashboardToken: string
  setDashboardToken: (token: string) => void
  storeUrl: string
  setStoreUrl: (url: string) => void
  signerMode: SignerMode
  passkey: PasskeyIdentity | null
  /** Set when passkey mode was requested but couldn't be activated — WebAuthn
   * unavailable, no platform authenticator, or the ceremony was cancelled/failed.
   * The signer silently stays on ed25519; this string is the visible disclosure
   * of that fallback, never swallowed. */
  passkeyNotice: string | null
  /** Switches the active signer. Selecting 'passkey' with no passkey registered
   * yet runs the registration ceremony (needs a user gesture — call this
   * directly from a click handler). On any failure it leaves `signerMode` on
   * 'ed25519' and sets `passkeyNotice`. */
  selectSignerMode: (mode: SignerMode) => Promise<void>
  /** The credential the next mandate ceremony should register, for the
   * currently active signer. */
  humanCredential: () => Credential
  /** Signs payload bytes as the human, dispatching on the currently active signer. */
  humanSign: (payloadBytes: Uint8Array) => Promise<SigEnvelope>
}

const IdentityContext = createContext<IdentityContextValue | null>(null)

export function IdentityProvider({ children }: { children: ReactNode }) {
  const [human, setHuman] = useState<HumanKeypair>(() => loadOrCreateHumanKeypair())
  const [dashboardToken, setTokenState] = useState<string>(() => getDashboardToken())
  const [storeUrl, setStoreUrlState] = useState<string>(() => getStoreUrl())
  const [signerMode, setSignerMode] = useState<SignerMode>('ed25519')
  const [passkey, setPasskey] = useState<PasskeyIdentity | null>(() => loadStoredPasskey())
  const [passkeyNotice, setPasskeyNotice] = useState<string | null>(null)

  const value = useMemo<IdentityContextValue>(() => {
    const identity = (): HumanIdentity => ({
      mode: signerMode,
      ed25519: human,
      passkey,
      rpId: typeof window !== 'undefined' ? window.location.hostname : 'localhost',
    })

    const selectSignerMode = async (mode: SignerMode): Promise<void> => {
      if (mode === 'ed25519') {
        setPasskeyNotice(null)
        setSignerMode('ed25519')
        return
      }

      if (passkey) {
        setPasskeyNotice(null)
        setSignerMode('passkey')
        return
      }

      try {
        if (!(await isPasskeyCapable())) {
          throw new Error('No platform authenticator available in this browser/context.')
        }
        const registered = await registerPasskey({
          rpId: typeof window !== 'undefined' ? window.location.hostname : 'localhost',
          rpName: 'Hundi',
          userName: 'human@hundi.local',
          userDisplayName: 'Hundi human signer',
        })
        persistPasskey(registered)
        setPasskey(registered)
        setPasskeyNotice(null)
        setSignerMode('passkey')
      } catch (err) {
        // Fail loud: never silently pretend the passkey path is active. Stay on
        // the ed25519 default and say exactly why the switch didn't happen.
        const reason = err instanceof Error ? err.message : String(err)
        setPasskeyNotice(`Passkey unavailable — using local key. ${reason}`)
        setSignerMode('ed25519')
      }
    }

    return {
      human,
      resetHuman: () => setHuman(resetHumanKeypair()),
      dashboardToken,
      setDashboardToken: (token: string) => {
        persistDashboardToken(token)
        setTokenState(token)
      },
      storeUrl,
      setStoreUrl: (url: string) => {
        persistStoreUrl(url)
        setStoreUrlState(url)
      },
      signerMode,
      passkey,
      passkeyNotice,
      selectSignerMode,
      humanCredential: () => resolveHumanCredential(identity()),
      humanSign: (payloadBytes: Uint8Array) => dispatchHumanSign(identity(), payloadBytes),
    }
  }, [human, dashboardToken, storeUrl, signerMode, passkey, passkeyNotice])

  return <IdentityContext.Provider value={value}>{children}</IdentityContext.Provider>
}

export function useIdentity(): IdentityContextValue {
  const ctx = useContext(IdentityContext)
  if (!ctx) throw new Error('useIdentity must be used within IdentityProvider')
  return ctx
}
