#!/usr/bin/env tsx
// Manual live-integration smoke test for the Claude buyer brain (U11). Registers
// a mandate against a running facilitator + store, lets Claude pick a real
// product from the real catalog, and settles it through the real facilitator —
// no fakes anywhere in this path. Not run in CI: needs a real ANTHROPIC_API_KEY
// with credit, plus a facilitator (`pnpm --filter @hundi/facilitator serve`) and
// store (`pnpm --filter @hundi/store start`) already running.
//
// Run with: pnpm --filter @hundi/claude-brain smoke:claude
// (reads the repo-root .env via tsx's --env-file flag, see package.json)

import { main } from '../src/index.js'

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
