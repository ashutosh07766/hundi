import { serve } from '@hono/node-server'
import { createApp } from './app.js'
import { openDb } from './db/index.js'
import { loadEnv } from './env.js'
import { noopExecutor } from './executor.js'

// Boots only against the loopback interface: this process holds Razorpay secrets and
// mints ceremony tokens, so it must never be reachable except through a trusted
// reverse proxy or from the same host. Binding 0.0.0.0 would expose it on the network.
const env = loadEnv()
const db = openDb(env.DB_PATH)
const app = createApp({ db, executor: noopExecutor, env })

serve({ fetch: app.fetch, hostname: '127.0.0.1', port: env.PORT }, (info) => {
  console.log(`facilitator listening on http://127.0.0.1:${info.port}`)
})
