#!/usr/bin/env tsx
// Manual live-integration smoke test for the provider-agnostic LLM buyer
// brain. Registers a mandate against a running facilitator + store, lets a
// real OpenAI-compatible chat model pick a real product from the real
// catalog, and settles it through the real facilitator — no fakes anywhere
// in this path. Not run in CI: needs a running facilitator
// (`pnpm --filter @hundi/facilitator serve`) and store
// (`pnpm --filter @hundi/store start`) already running, plus a free LLM key.
//
// Groq (free, no card — console.groq.com):
//   LLM_BASE_URL=https://api.groq.com/openai/v1 \
//   LLM_MODEL=llama-3.3-70b-versatile \
//   LLM_API_KEY=gsk_... \
//   pnpm --filter @hundi/llm-brain smoke:llm
//
// Google Gemini (free tier — aistudio.google.com):
//   LLM_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai \
//   LLM_MODEL=gemini-2.0-flash \
//   LLM_API_KEY=AIza... \
//   pnpm --filter @hundi/llm-brain smoke:llm
//
// Local Ollama (no key needed — any dummy string works):
//   LLM_BASE_URL=http://localhost:11434/v1 \
//   LLM_MODEL=llama3.1 \
//   LLM_API_KEY=ollama \
//   pnpm --filter @hundi/llm-brain smoke:llm
//
// (reads the repo-root .env via tsx's --env-file flag, see package.json —
// set the LLM_* vars there, or inline as shown above)

import { main } from '../src/index.js'

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
