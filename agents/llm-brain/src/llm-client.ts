/**
 * Plain-fetch client for the OpenAI Chat Completions shape — `POST
 * {baseUrl}/chat/completions` with `{model, messages, response_format}` in,
 * `{choices[0].message.content}` out. Groq, Google's Gemini OpenAI-compat
 * endpoint, OpenRouter, Together, and local Ollama all implement this same
 * surface, so swapping providers is a base URL + model + key change, never a
 * code change. No vendor SDK dependency on purpose — one fetch call covers
 * every provider this brain needs to support.
 */

export type ChatJsonArgs = {
  baseUrl: string
  apiKey: string
  model: string
  system: string
  user: string
  /** Injectable so tests never hit the network. Defaults to global `fetch`. */
  fetchImpl?: typeof fetch
  /** Injectable backoff sleep so tests don't actually wait. Defaults to setTimeout. */
  sleepImpl?: (ms: number) => Promise<void>
}

export type LlmPick = { chosen_sku?: string; reason?: string }

const TIMEOUT_MS = 30_000
const MAX_ATTEMPTS = 3
const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/** Asks the model for strict JSON (`response_format: json_object`, harmless
 * to send even when a provider ignores it) and extracts whatever
 * `{chosen_sku, reason}` fields it can parse out of the reply. Never throws —
 * a network error, non-2xx status, or malformed/missing content all resolve
 * to `{}` so callers can treat "no usable pick" uniformly and fall back to
 * their own guardrail rule. */
export async function chatJson(args: ChatJsonArgs): Promise<LlmPick> {
  const fetchImpl = args.fetchImpl ?? fetch
  const sleep = args.sleepImpl ?? defaultSleep
  const base = args.baseUrl.replace(/\/$/, '')

  const post = (useJsonMode: boolean) => {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS)
    return fetchImpl(`${base}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${args.apiKey}`,
      },
      body: JSON.stringify({
        model: args.model,
        messages: [
          { role: 'system', content: args.system },
          { role: 'user', content: args.user },
        ],
        // Reasoning models (e.g. gpt-oss) spend output tokens "thinking" before
        // emitting the JSON answer — too small a budget yields empty content.
        max_tokens: 2048,
        // json_object mode helps providers that honor it, but some (e.g. Groq's
        // gpt-oss models) reject it with a 400. parsePick's regex handles raw
        // or fenced JSON anyway, so on rejection we retry without the flag.
        ...(useJsonMode ? { response_format: { type: 'json_object' } } : {}),
      }),
      signal: controller.signal,
    }).finally(() => clearTimeout(timeout))
  }

  // Retry transient failures (429 rate-limit, 5xx) with backoff. Without this a
  // free-tier rate limit makes chatJson return {} → the brain silently falls
  // back to the cheapest item, which for a "buy what I asked" agent is the wrong
  // thing to buy, not just a degraded one. Honor Retry-After when present.
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      let res = await post(true)
      if (res.status === 400) res = await post(false)
      if (res.ok) {
        const body = (await res.json()) as {
          choices?: Array<{ message?: { content?: string } }>
        }
        const content = body.choices?.[0]?.message?.content
        return content ? parsePick(content) : {}
      }
      if (res.status === 429 || res.status >= 500) {
        if (attempt === MAX_ATTEMPTS - 1) return {}
        const retryAfter = Number(res.headers.get('retry-after'))
        const waitMs =
          Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 2000 * 2 ** attempt
        await sleep(Math.min(waitMs, 15000))
        continue
      }
      return {} // non-retryable client error
    } catch {
      if (attempt === MAX_ATTEMPTS - 1) return {}
      await sleep(2000 * 2 ** attempt)
    }
  }
  return {}
}

/** Extracts the first `{...}` object from `text` and pulls out `chosen_sku`/
 * `reason` if they're strings. Tolerant of surrounding prose or markdown
 * fences some providers add even when JSON mode is requested. */
function parsePick(text: string): LlmPick {
  const match = text.match(/\{[\s\S]*\}/)
  if (!match) return {}
  try {
    const parsed: unknown = JSON.parse(match[0])
    if (typeof parsed !== 'object' || parsed === null) return {}
    const obj = parsed as Record<string, unknown>
    const pick: LlmPick = {}
    if (typeof obj.chosen_sku === 'string') pick.chosen_sku = obj.chosen_sku
    if (typeof obj.reason === 'string') pick.reason = obj.reason
    return pick
  } catch {
    return {}
  }
}
