import { useState } from 'react'
import { Header } from './components/Header.js'
import { HowItWorks } from './components/HowItWorks.js'
import { LiveLedger } from './components/LiveLedger.js'
import { MandateCeremony } from './components/MandateCeremony.js'
import { MandatesList } from './components/MandatesList.js'
import { PendingApprovals } from './components/PendingApprovals.js'
import { IdentityProvider } from './context/identity-context.js'

const TABS = [
  { id: 'ceremony', label: 'Mandate ceremony' },
  { id: 'approvals', label: 'Pending approvals' },
  { id: 'ledger', label: 'Live ledger' },
  { id: 'mandates', label: 'Mandates' },
] as const

type TabId = (typeof TABS)[number]['id']

function App() {
  const [tab, setTab] = useState<TabId>('ceremony')

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
          {tab === 'ceremony' && <MandateCeremony />}
          {tab === 'approvals' && <PendingApprovals />}
          {tab === 'ledger' && <LiveLedger />}
          {tab === 'mandates' && <MandatesList />}
        </main>
      </div>
    </IdentityProvider>
  )
}

export default App
