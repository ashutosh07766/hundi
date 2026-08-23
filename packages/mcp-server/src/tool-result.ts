import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'

/** Every tool in this server returns structured data as pretty-printed JSON text —
 * the one content shape every MCP client (Claude Desktop, Cursor, a raw SDK client)
 * renders without needing to support a richer content type. Throwing an `Error`
 * from a tool handler is the correct way to signal a tool-level failure — the SDK
 * catches it and returns `{ isError: true, content: [...] }` itself (see
 * `McpServer`'s `executeToolHandler`), so handlers never need to build that shape
 * by hand for error cases. */
export function jsonResult(data: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
}
