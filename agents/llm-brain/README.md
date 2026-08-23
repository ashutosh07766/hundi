# @hundi/llm-brain

A provider-agnostic buyer brain: same guardrails and money path as
`@hundi/scripted-brain` and `@hundi/claude-brain`, but the "which product"
decision is made by any OpenAI-compatible chat model — Groq, Google Gemini's
OpenAI endpoint, OpenRouter, Together, or a local Ollama. No vendor SDK; just
`fetch` against `POST {baseUrl}/chat/completions`.

## Get a free key

- **Groq** (recommended — fast, generous free tier, no card required):
  [console.groq.com](https://console.groq.com) → API Keys → Create.
- **Google Gemini** (free tier): [aistudio.google.com](https://aistudio.google.com) →
  Get API key. Uses Gemini's OpenAI-compatibility endpoint.

## Env vars

| Var | Example |
| --- | --- |
| `LLM_BASE_URL` | `https://api.groq.com/openai/v1` |
| `LLM_API_KEY` | `gsk_...` |
| `LLM_MODEL` | `llama-3.3-70b-versatile` |

Set these (plus `DASHBOARD_TOKEN`) in the repo-root `.env`.

## Run

```bash
# one purchase against a running facilitator + store
pnpm --filter @hundi/llm-brain buy

# same, with explicit live smoke entry point
pnpm --filter @hundi/llm-brain smoke:llm
```

See `bin/smoke-llm.ts` for the exact env line per provider (Groq / Gemini /
Ollama).
