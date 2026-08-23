/**
 * One-command smart purchase against a real onboarded store, powered by any
 * OpenAI-compatible LLM (free Groq/Gemini/Ollama). The LLM reads the goal and
 * picks the best-fitting product by relevance — not just the cheapest — then
 * settles through the facilitator's guardrails on Razorpay TEST mode.
 *
 *   Usage: tsx --env-file=../../.env bin/shop-real-store.ts <merchant_id> "<goal>" [ceilingRupees]
 *   e.g.:  tsx --env-file=../../.env bin/shop-real-store.ts myfrido-com "leather casual sneakers for men" 5000
 *
 * Needs: facilitator on :8790, the store onboarded, and LLM_BASE_URL/LLM_API_KEY/
 * LLM_MODEL + DASHBOARD_TOKEN in the repo-root .env.
 */
import http from 'node:http'
import { HttpBuyerTools } from '../../scripted-brain/src/agent-tools.ts'
import { registerMandate } from '../../scripted-brain/src/session.ts'
import { runLlmPurchase } from '../src/llm-brain.ts'

const FAC = process.env.FACILITATOR_URL ?? 'http://127.0.0.1:8790'
const TOKEN = process.env.DASHBOARD_TOKEN ?? ''
const merchant = process.argv[2] ?? 'myfrido-com'
const goal = process.argv[3] ?? 'running shoes'
const ceilingPaise = Number(process.argv[4] ?? '5000') * 100
const cfg = {
  baseUrl: process.env.LLM_BASE_URL ?? '',
  apiKey: process.env.LLM_API_KEY ?? '',
  model: process.env.LLM_MODEL ?? '',
}

async function main() {
  const feed = await (await fetch(`${FAC}/catalog/${merchant}`)).json()
  if (!Array.isArray(feed) || feed.length === 0)
    throw new Error(`no catalog for ${merchant} — onboard it first`)
  const srv = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify(req.url?.startsWith('/api/catalog') ? feed : {}))
  })
  await new Promise<void>((r) => srv.listen(8796, '127.0.0.1', () => r()))

  const tools = new HttpBuyerTools({
    storeUrl: 'http://127.0.0.1:8796',
    facilitatorUrl: FAC,
    pollTimeoutMs: 120000,
    pollIntervalMs: 2000,
  })
  const m = await registerMandate({
    facilitatorUrl: FAC,
    dashboardToken: TOKEN,
    goal,
    ceiling_paise: ceilingPaise,
    approval_threshold_paise: ceilingPaise,
    merchants: [merchant],
    expires_at: Math.floor(Date.now() / 1000) + 3600,
  })
  console.log(`\nGOAL: "${goal}"  ·  store: ${merchant}  ·  cap ₹${ceilingPaise / 100}\n`)
  const p = await runLlmPurchase(
    {
      goal: { query: goal, ceiling_paise: ceilingPaise, threshold_paise: ceilingPaise },
      mandate: { intent: m.intent, agent: m.agentKeyPair },
      config: cfg,
    },
    tools,
  )
  const prod = (p as { product?: { title?: string; price_paise?: number } }).product
  console.log(
    `\nLLM CHOSE: ${prod?.title} @ ₹${(prod?.price_paise ?? 0) / 100}  →  ${(p as { settlement?: { state?: string }; status?: string }).settlement?.state ?? (p as { status?: string }).status}\n`,
  )
  srv.close()
}
main().catch((e) => {
  console.error('failed:', e instanceof Error ? e.message : e)
  process.exit(1)
})
