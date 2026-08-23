#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { loadOrCreateAgentIdentity } from './identity.js'
import { createHundiMcpServer } from './server.js'

function facilitatorUrl(): string {
  const override = process.env.HUNDI_FACILITATOR_URL?.trim()
  return (override && override.length > 0 ? override : 'http://127.0.0.1:8790').replace(/\/$/, '')
}

async function main(): Promise<void> {
  const agent = loadOrCreateAgentIdentity()
  const server = createHundiMcpServer({ agent, facilitatorUrl: facilitatorUrl() })
  await server.connect(new StdioServerTransport())
}

main().catch((err) => {
  console.error('hundi-mcp: fatal', err)
  process.exit(1)
})
