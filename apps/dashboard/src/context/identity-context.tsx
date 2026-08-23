/**
 * The dashboard's own signing identity: "the human" who mints mandates and
 * decides approvals/revocations (see lib/signing.ts for the KTD15 note on
 * why this is a raw key here instead of a passkey), plus the dashboard token
 * that gates ceremony-token minting. Both are localStorage-backed so a page
 * reload doesn't orphan mandates already registered under the current key.
 */

import type { ReactNode } from 'react'
import { createContext, useContext, useMemo, useState } from 'react'
import { getDashboardToken, setDashboardToken as persistDashboardToken } from '../lib/config.js'
import type { HumanKeypair } from '../lib/signing.js'
import { loadOrCreateHumanKeypair, resetHumanKeypair } from '../lib/signing.js'

type IdentityContextValue = {
  human: HumanKeypair
  resetHuman: () => void
  dashboardToken: string
  setDashboardToken: (token: string) => void
}

const IdentityContext = createContext<IdentityContextValue | null>(null)

export function IdentityProvider({ children }: { children: ReactNode }) {
  const [human, setHuman] = useState<HumanKeypair>(() => loadOrCreateHumanKeypair())
  const [dashboardToken, setTokenState] = useState<string>(() => getDashboardToken())

  const value = useMemo<IdentityContextValue>(
    () => ({
      human,
      resetHuman: () => setHuman(resetHumanKeypair()),
      dashboardToken,
      setDashboardToken: (token: string) => {
        persistDashboardToken(token)
        setTokenState(token)
      },
    }),
    [human, dashboardToken],
  )

  return <IdentityContext.Provider value={value}>{children}</IdentityContext.Provider>
}

export function useIdentity(): IdentityContextValue {
  const ctx = useContext(IdentityContext)
  if (!ctx) throw new Error('useIdentity must be used within IdentityProvider')
  return ctx
}
