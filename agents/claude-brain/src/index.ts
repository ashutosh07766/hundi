/**
 * `pnpm buy` — registers a mandate against a running facilitator/store and runs
 * one Claude-brain purchase end to end, printing Claude's chosen product, its
 * rationale, and the settlement outcome. Needs a real ANTHROPIC_API_KEY with
 * credit and a running facilitator (default :8790) + store (default :8791) —
 * see agents/scripted-brain/src/session.ts and the store/facilitator server
 * entry points for how to boot them.
 */

import process from 'node:process'
import Anthropic from '@anthropic-ai/sdk'
import { MERCHANT_ID } from '../../../apps/store/src/catalog.js'
import { HttpBuyerTools } from '../../scripted-brain/src/agent-tools.js'
import { registerMandate } from '../../scripted-brain/src/session.js'
import { runClaudePurchase } from './claude-brain.js'

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
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is required (set it in .env)')

  const anthropic = new Anthropic({ apiKey })
  const tools = new HttpBuyerTools({ storeUrl: STORE_URL, facilitatorUrl: FACILITATOR_URL })

  const { intent, agentKeyPair } = await registerMandate({
    facilitatorUrl: FACILITATOR_URL,
    dashboardToken,
    goal: 'buy running shoes with good cushioning',
    ceiling_paise: CEILING_PAISE,
    approval_threshold_paise: THRESHOLD_PAISE,
    merchants: [MERCHANT_ID],
    expires_at: future(),
  })

  const outcome = await runClaudePurchase(
    {
      goal: {
        query: 'running shoes with good cushioning under 4000',
        ceiling_paise: CEILING_PAISE,
        threshold_paise: THRESHOLD_PAISE,
      },
      mandate: { intent, agent: agentKeyPair },
    },
    tools,
    { anthropic },
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
  AnthropicClient,
  ClaudeBrainDeps,
  ClaudeGoal,
  ClaudePurchaseArgs,
} from './claude-brain.js'
export { DEFAULT_MODEL, runClaudePurchase } from './claude-brain.js'
