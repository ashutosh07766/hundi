import { serve } from '@hono/node-server'
import { createApp } from './app.js'

const PORT = 8791

const app = createApp()

serve({ fetch: app.fetch, hostname: '127.0.0.1', port: PORT }, (info) => {
  console.log(`hundi store listening on http://127.0.0.1:${info.port}`)
})
