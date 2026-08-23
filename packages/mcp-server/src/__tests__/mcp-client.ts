/** Connects a real MCP `Client` to a server entirely in-process via the SDK's
 * `InMemoryTransport` pair — exercises the actual protocol framing (JSON-RPC over
 * the transport, schema-validated tool calls) instead of calling handler functions
 * directly, while staying fast and network-free. */

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

export async function connectedClient(server: McpServer): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'hundi-mcp-test-client', version: '0.0.0' })
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)])
  return client
}

// client.callTool()'s return type is a union with the SDK's experimental task-based
// result shape (`{ toolResult }`, no `content`) — this server never uses tasks, so
// every real call resolves to the plain content-array shape these helpers assert.
type CallToolReturn = Awaited<ReturnType<Client['callTool']>>

/** Extracts the first text content block's string — every tool in this server
 * returns exactly one (see tool-result.ts's `jsonResult`). */
export function textOf(result: CallToolReturn): string {
  if (!('content' in result) || !Array.isArray(result.content)) {
    throw new Error(`expected a content-array tool result, got ${JSON.stringify(result)}`)
  }
  const first = result.content[0] as { type?: string; text?: string } | undefined
  if (first?.type !== 'text' || typeof first.text !== 'string') {
    throw new Error(`expected a text content block, got ${JSON.stringify(result.content)}`)
  }
  return first.text
}

export function jsonOf<T>(result: CallToolReturn): T {
  return JSON.parse(textOf(result)) as T
}
