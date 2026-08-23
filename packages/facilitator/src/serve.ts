import { serve } from '@hono/node-server'
import { createApp } from './app.js'
import { closeBrowserScanner } from './browser-scan.js'
import { openDb } from './db/index.js'
import { loadEnv } from './env.js'
import { createExecutor } from './executor.js'
import { createCheckoutDriver } from './rails/checkout-driver.js'
import { createRazorpayClient } from './razorpay-client.js'
import { seedDemoStoreCatalog } from './seed-demo-store.js'
import { createSweep } from './sweep.js'

// Matches apps/dashboard's DEFAULT_STORE_URL (lib/config.ts) — the demo store has no
// env-configurable port of its own today, so both sides hardcode the same default.
const DEMO_STORE_URL = 'http://127.0.0.1:8791'

// Boots only against the loopback interface: this process holds Razorpay secrets and
// mints ceremony tokens, so it must never be reachable except through a trusted
// reverse proxy or from the same host. Binding 0.0.0.0 would expose it on the network.
const env = loadEnv()
const db = openDb(env.DB_PATH)

const razorpay = createRazorpayClient({
  keyId: env.RAZORPAY_KEY_ID,
  keySecret: env.RAZORPAY_KEY_SECRET,
})
const driver = createCheckoutDriver({
  keyId: env.RAZORPAY_KEY_ID,
  keySecret: env.RAZORPAY_KEY_SECRET,
  razorpay,
  checkoutPagePort: env.CHECKOUT_PAGE_PORT,
})
const executor = createExecutor({ db, env, driver })

const app = createApp({ db, executor, env, razorpay })

// The sweep is production-only infra (app.ts stays free of timers so tests drive
// sweep.runOnce() directly instead of racing a live interval).
const sweep = createSweep({
  db,
  deps: {
    razorpay,
    executor,
    now: () => Math.floor(Date.now() / 1000),
    ttls: { approvalTtlMs: env.APPROVAL_TTL_MS },
  },
  intervalMs: env.SWEEP_INTERVAL_MS,
})
sweep.start()

// Fire-and-forget — see seed-demo-store.ts. Deliberately not awaited so a slow or absent
// demo store never delays the facilitator itself from binding its port below.
void seedDemoStoreCatalog(db, DEMO_STORE_URL)

serve({ fetch: app.fetch, hostname: '127.0.0.1', port: env.PORT }, (info) => {
  console.log(`facilitator listening on http://127.0.0.1:${info.port}`)
})

// The browser-scan fallback only launches Chromium lazily, on the first bot-gated
// onboard — but once launched it stays alive for the process lifetime (see
// browser-scan.ts), so it needs an explicit close on exit or it lingers as an orphaned
// process.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void closeBrowserScanner().finally(() => process.exit(0))
  })
}
