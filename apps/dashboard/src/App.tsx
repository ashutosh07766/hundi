import { useState } from 'react'
import { Header } from './components/Header.js'
import { HowItWorks } from './components/HowItWorks.js'
import { LiveLedger } from './components/LiveLedger.js'
import { MandateCeremony } from './components/MandateCeremony.js'
import { MandatesList } from './components/MandatesList.js'
import { Orders } from './components/Orders.js'
import { PendingApprovals } from './components/PendingApprovals.js'
import { Proposals } from './components/Proposals.js'
import { Stores } from './components/Stores.js'
import { IdentityProvider } from './context/identity-context.js'

const TABS = [
  { id: 'stores', label: 'Stores' },
  { id: 'proposals', label: 'Proposals' },
  { id: 'ceremony', label: 'Mandate ceremony' },
  { id: 'approvals', label: 'Pending approvals' },
  { id: 'ledger', label: 'Live ledger' },
  { id: 'orders', label: 'Orders' },
  { id: 'mandates', label: 'Mandates' },
] as const

type TabId = (typeof TABS)[number]['id']

/** Lands on the Proposals tab when the URL carries an approve_url deep link
 * (`/?propose=<id>`) — the agent's prepare_mandate tool hands the human exactly this
 * URL, so opening it should go straight to the approval card, not the Stores tab. */
function initialTab(): TabId {
  if (typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('propose')) {
    return 'proposals'
  }
  return 'stores'
}

function App() {
  const [tab, setTab] = useState<TabId>(initialTab)

  return (
    <IdentityProvider>
      <Header />
      <div className="page">
        <HowItWorks />
        <nav className="tabs">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              className={`tabs__item ${tab === t.id ? 'tabs__item--active' : ''}`}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </nav>
        <main className="main">
          {tab === 'stores' && <Stores />}
          {tab === 'proposals' && <Proposals />}
          {tab === 'ceremony' && <MandateCeremony />}
          {tab === 'approvals' && <PendingApprovals />}
          {tab === 'ledger' && <LiveLedger />}
          {tab === 'orders' && <Orders />}
          {tab === 'mandates' && <MandatesList />}
        </main>
      </div>
    </IdentityProvider>
  )
}

export default App
