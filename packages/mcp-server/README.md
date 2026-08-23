# @hundi/mcp-server

The safe counterpart to a raw payment-API MCP server. Razorpay ships an MCP server
that hands an LLM its payment APIs directly, with no policy layer in between. This
server hands an LLM *shopping* tools only — search stores, propose a purchase — and
every payment passes the Hundi facilitator's deterministic mandate checks (spending
ceiling, merchant scope, expiry, revocation, exact price match against the live
catalog) before any money moves. It runs over the [Model Context
Protocol](https://modelcontextprotocol.io), so any MCP client — Claude Desktop,
Cursor, a custom agent — can shop real stores through it.

## Identity model

This server holds **one persistent Ed25519 keypair** — its shopping identity.
Generated on first run and stored at `~/.hundi/mcp-agent-key.json` (chmod 600), or at
the path in `HUNDI_AGENT_KEY_FILE` if set. Every later run reuses the same keypair.

A human authorizes this identity by creating a **mandate** in the Hundi dashboard and
pasting the agent's public key into the ceremony's "Agent public key" field. Once
authorized, this server can shop under that mandate — spend up to its ceiling, at its
scoped merchants, until it expires. It can **never** approve or revoke a mandate:
those actions require the human's own, separate key, and only happen in the
dashboard. That split — one key that can propose spending, a different key that must
authorize it — is the entire security model.

## Setup (60 seconds)

1. **Run the facilitator and dashboard.** See the repo root for `pnpm serve` (facilitator, defaults to `:8790`) and the dashboard dev server.
2. **Point an MCP client at this server.** Claude Desktop config
   (`claude_desktop_config.json`):

   ```json
   {
     "mcpServers": {
       "hundi": {
         "command": "npx",
         "args": ["tsx", "/absolute/path/to/hundi/packages/mcp-server/src/index.ts"],
         "env": { "HUNDI_FACILITATOR_URL": "http://127.0.0.1:8790" }
       }
     }
   }
   ```

   Or, after `pnpm build`, run the compiled bundle directly instead of `tsx`:

   ```json
   {
     "mcpServers": {
       "hundi": {
         "command": "node",
         "args": ["/absolute/path/to/hundi/packages/mcp-server/dist/index.js"],
         "env": { "HUNDI_FACILITATOR_URL": "http://127.0.0.1:8790" }
       }
     }
   }
   ```

3. **Ask the AI for its agent identity.** In your MCP client: *"What's your Hundi
   agent identity?"* — it calls `get_agent_identity` and shows you a public key.
4. **Authorize it in the dashboard.** Start a mandate ceremony, paste the public key
   into "Agent public key", set a goal/ceiling/merchants/expiry, and sign it as the
   human. The mandate now authorizes this exact agent process.
5. **Tell the AI to buy something.** *"Buy me the cheapest running shoe from
   demo-store-1 under this mandate."* It calls `search_products`, then
   `request_purchase`. A below-threshold purchase captures immediately; an
   above-threshold one is parked as `pending_approval` until you approve it in the
   dashboard's Pending approvals tab.

## Tools

| Tool | What it does |
|---|---|
| `get_agent_identity` | Returns this server's public key and the mandates currently authorizing it. Call this first. |
| `list_stores` | Lists every store shoppable through the facilitator. |
| `get_store_info` | A quick profile of one store — name, product/in-stock counts, sample titles. |
| `search_products` | Searches a store's live catalog by title/brand. |
| `request_purchase` | The only money-adjacent tool. Builds and signs a cart (price always read fresh from the catalog, never from the caller), proposes it to the facilitator, and reports `captured`, `pending_approval`, or a rejection reason. Never auto-approves. |
| `get_order` | Fetches a settlement's receipt — state, items, amount, Razorpay payment id if captured, ledger timeline. |

## Security model — what this server structurally cannot do

No tool here exposes Razorpay credentials, issues a refund, approves a mandate,
revokes a mandate, or executes a settlement directly. `request_purchase` only ever
*proposes* a cart to the facilitator; the facilitator's deterministic checks decide
whether it's allowed, and a human decides anything parked as `pending_approval`. This
isn't a policy this server promises to follow — those capabilities simply don't exist
on any tool it registers.

## Development

```bash
pnpm --filter @hundi/mcp-server typecheck
pnpm --filter @hundi/mcp-server test
pnpm --filter @hundi/mcp-server build   # → dist/index.js, a runnable single-file bundle
pnpm --filter @hundi/mcp-server start   # dev: runs src/index.ts directly via tsx
pnpm --filter @hundi/mcp-server smoke   # live integration smoke test — see bin/smoke-live.ts
```

`HUNDI_FACILITATOR_URL` defaults to `http://127.0.0.1:8790`. `HUNDI_AGENT_KEY_FILE`
defaults to `~/.hundi/mcp-agent-key.json`.
