/**
 * `pnpm buy` — registers a mandate against a running facilitator/store and
 * runs one LLM-brain purchase end to end, printing the model's chosen
 * product, its rationale, and the settlement outcome. Needs a running
 * facilitator (default :8790) + store (default :8791) — see
 * agents/scripted-brain/src/session.ts and the store/facilitator server entry
 * points for how to boot them — plus LLM_BASE_URL / LLM_API_KEY / LLM_MODEL
 * pointed at any OpenAI-compatible chat-completions endpoint (see README.md
 * for free-tier options).
 */

import process from 'node:process'
import { MERCHANT_ID } from '../../../apps/store/src/catalog.js'
import { HttpBuyerTools } from '../../scripted-brain/src/agent-tools.js'
import { registerMandate } from '../../scripted-brain/src/session.js'
import { runLlmPurchase } from './llm-brain.js'

const FACILITATOR_URL = process.env.FACILITATOR_URL ?? 'http://localhost:8790'
const STORE_URL = process.env.STORE_URL ?? 'http://localhost:8791'
const CEILING_PAISE = 500_000
const THRESHOLD_PAISE = 400_000
const HOUR_SECONDS = 3600

function future(): number {
  return Math.floor(Date.now() / 1000) + HOUR_SECONDS
}

export async function main(): Promise<void> {
  const dashboardToken = process.env.DASHBOARD_TOKEN
  if (!dashboardToken) throw new Error('DASHBOARD_TOKEN is required (set it in .env)')
  const baseUrl = process.env.LLM_BASE_URL
  const apiKey = process.env.LLM_API_KEY
  const model = process.env.LLM_MODEL
  if (!baseUrl || !apiKey || !model) {
    throw new Error('LLM_BASE_URL, LLM_API_KEY, and LLM_MODEL are required (set them in .env)')
  }

  const tools = new HttpBuyerTools({ storeUrl: STORE_URL, facilitatorUrl: FACILITATOR_URL })

  const { intent, agentKeyPair } = await registerMandate({
    facilitatorUrl: FACILITATOR_URL,
    dashboardToken,
    goal: 'buy foot alignment socks',
    ceiling_paise: CEILING_PAISE,
    approval_threshold_paise: THRESHOLD_PAISE,
    merchants: [MERCHANT_ID],
    expires_at: future(),
  })

  const outcome = await runLlmPurchase(
    {
      goal: {
        query: 'foot alignment socks',
        ceiling_paise: CEILING_PAISE,
        threshold_paise: THRESHOLD_PAISE,
      },
      mandate: { intent, agent: agentKeyPair },
      config: { baseUrl, apiKey, model },
    },
    tools,
  )

  console.log(JSON.stringify(outcome, null, 2))
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`
if (isMain) {
  main().catch((err) => {
    console.error(err)
    process.exitCode = 1
  })
}

export type {
  ChatClient,
  ChooseProductArgs,
  ChooseProductGoal,
  ChooseProductResult,
  GuardrailOverrideReason,
  LlmBrainDeps,
  LlmConfig,
  LlmGoal,
  LlmPurchaseArgs,
} from './llm-brain.js'
export { buildDefaultChatClient, chooseProduct, fallbackPick, runLlmPurchase } from './llm-brain.js'
