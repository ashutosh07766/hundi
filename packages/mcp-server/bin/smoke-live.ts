#!/usr/bin/env tsx
// Manual live-integration smoke test. Spawns the real MCP server (this package's
// src/index.ts) as a stdio subprocess and drives it as any MCP client would:
// list_stores, get_agent_identity, search_products, then request_purchase against
// the REAL local facilitator (expected already running — see docs/tech or `pnpm
// serve` in packages/facilitator) using a mandate registered for this run via the
// same scripted-issuance ceremony path agents/scripted-brain/src/session.ts uses
// for its own tests. Not run in CI — needs a live facilitator and, if the
// purchase reaches the executor, a real (test-mode) Razorpay payment.
//
// Usage: `pnpm smoke` (reads the repo-root .env via tsx's --env-file flag, see
// package.json) — requires DASHBOARD_TOKEN in that .env.

import { randomUUID } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { registerMandate } from '../../../agents/scripted-brain/src/session.js'
import { loadOrCreateAgentIdentity } from '../src/identity.js'

function textOf(result: { content?: unknown }): string {
  const content = result.content as Array<{ type: string; text?: string }> | undefined
  const first = content?.[0]
  if (first?.type !== 'text' || typeof first.text !== 'string') {
    throw new Error(`expected a text content block, got ${JSON.stringify(result)}`)
  }
  return first.text
}

async function main(): Promise<void> {
  const facilitatorUrl = process.env.HUNDI_FACILITATOR_URL ?? 'http://127.0.0.1:8790'
  const dashboardToken = process.env.DASHBOARD_TOKEN
  if (!dashboardToken) throw new Error('smoke-live: DASHBOARD_TOKEN is required (repo-root .env)')

  // A throwaway identity file per run — never the real ~/.hundi/mcp-agent-key.json a
  // human would actually authorize, so this script can't collide with real usage.
  const keyFile = path.join(os.tmpdir(), `hundi-mcp-smoke-${randomUUID()}.json`)
  const agent = loadOrCreateAgentIdentity(keyFile)
  console.log(`smoke: agent identity ${agent.publicKeyHex.slice(0, 16)}…`)

  const now = Math.floor(Date.now() / 1000)
  const { mandateId } = await registerMandate({
    facilitatorUrl,
    dashboardToken,
    goal: 'MCP server smoke test',
    ceiling_paise: 10_00_000, // ₹10,000 — comfortably covers any demo-store item
    approval_threshold_paise: 10_00_000, // == ceiling: every purchase here auto-approves
    merchants: ['demo-store-1'],
    expires_at: now + 3600,
    agent,
  })
  console.log(`smoke: registered mandate ${mandateId}`)

  const transport = new StdioClientTransport({
    command: 'tsx',
    args: [path.join(import.meta.dirname, '..', 'src', 'index.ts')],
    env: {
      ...(process.env as Record<string, string>),
      HUNDI_FACILITATOR_URL: facilitatorUrl,
      HUNDI_AGENT_KEY_FILE: keyFile,
    },
  })
  const client = new Client({ name: 'hundi-mcp-smoke', version: '0.0.0' })
  await client.connect(transport)

  try {
    const { tools } = await client.listTools()
    console.log(`smoke: server exposes tools: ${tools.map((t) => t.name).join(', ')}`)

    const stores = JSON.parse(
      textOf(await client.callTool({ name: 'list_stores', arguments: {} })),
    ) as { merchant_id: string; name: string; product_count: number }[]
    console.log(`smoke: list_stores → ${stores.length} stores`)
    if (!stores.some((s) => s.merchant_id === 'demo-store-1')) {
      throw new Error('smoke: demo-store-1 not present in list_stores output')
    }

    const identity = JSON.parse(
      textOf(await client.callTool({ name: 'get_agent_identity', arguments: {} })),
    ) as { agent_public_key_hex: string; authorizing_mandates: { mandate_id: string }[] }
    if (identity.agent_public_key_hex !== agent.publicKeyHex) {
      throw new Error('smoke: get_agent_identity returned a different key than this process holds')
    }
    if (!identity.authorizing_mandates.some((m) => m.mandate_id === mandateId)) {
      throw new Error('smoke: get_agent_identity did not list the mandate just registered')
    }
    console.log('smoke: get_agent_identity confirms identity + mandate visibility')

    const search = JSON.parse(
      textOf(
        await client.callTool({
          name: 'search_products',
          arguments: { merchant_id: 'demo-store-1', query: 'Runner' },
        }),
      ),
    ) as { products: { sku: string; title: string; availability: string }[] }
    const pick = search.products.find((p) => p.availability === 'in_stock')
    if (!pick) throw new Error('smoke: no in-stock product matched "Runner" in demo-store-1')
    console.log(`smoke: search_products → picked ${pick.sku} "${pick.title}"`)

    const purchase = JSON.parse(
      textOf(
        await client.callTool({
          name: 'request_purchase',
          arguments: { merchant_id: 'demo-store-1', sku: pick.sku, qty: 1, mandate_id: mandateId },
        }),
      ),
    ) as { state: string; settlement_id: string; message: string }
    console.log(`smoke: request_purchase → ${purchase.state}: ${purchase.message}`)

    if (purchase.state === 'captured') {
      const order = JSON.parse(
        textOf(
          await client.callTool({
            name: 'get_order',
            arguments: { settlement_id: purchase.settlement_id },
          }),
        ),
      ) as { razorpay_payment_id: string | null }
      console.log(`smoke: get_order → razorpay_payment_id=${order.razorpay_payment_id}`)
    }

    console.log('smoke: OK')
  } finally {
    await client.close()
  }
}

main().catch((err) => {
  console.error('smoke: fatal', err)
  process.exit(1)
})
