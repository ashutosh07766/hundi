import { serve } from '@hono/node-server'
import { createApp } from './app.js'
import { openDb } from './db/index.js'
import { loadEnv } from './env.js'
import { createExecutor } from './executor.js'
import { createCheckoutDriver } from './rails/checkout-driver.js'
import { createRazorpayClient } from './razorpay-client.js'

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

const app = createApp({ db, executor, env })

serve({ fetch: app.fetch, hostname: '127.0.0.1', port: env.PORT }, (info) => {
  console.log(`facilitator listening on http://127.0.0.1:${info.port}`)
})
