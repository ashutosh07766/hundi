import { describe, expect, it, vi } from 'vitest'
import { chatJson } from '../llm-client.js'

function openAiResponse(content: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('chatJson', () => {
  const args = {
    baseUrl: 'https://api.example.test/v1',
    apiKey: 'k',
    model: 'm',
    system: 's',
    user: 'u',
  }

  it('extracts {chosen_sku, reason} from a normal OpenAI-shaped completion', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(openAiResponse('{"chosen_sku": "sku-1", "reason": "great fit"}'))

    const pick = await chatJson({ ...args, fetchImpl: fetchImpl as unknown as typeof fetch })

    expect(pick).toEqual({ chosen_sku: 'sku-1', reason: 'great fit' })
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://api.example.test/v1/chat/completions')
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer k')
    const body = JSON.parse(init.body as string)
    expect(body.model).toBe('m')
    expect(body.messages).toEqual([
      { role: 'system', content: 's' },
      { role: 'user', content: 'u' },
    ])
  })

  it('retries on 429 rate-limit then succeeds (no silent give-up)', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response('rate limited', { status: 429 }))
      .mockResolvedValueOnce(openAiResponse('{"chosen_sku": "sku-9", "reason": "ok"}'))
    const sleepImpl = vi.fn().mockResolvedValue(undefined)

    const pick = await chatJson({
      ...args,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleepImpl,
    })

    expect(pick).toEqual({ chosen_sku: 'sku-9', reason: 'ok' })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(sleepImpl).toHaveBeenCalledOnce()
  })

  it('gives up (returns {}) after exhausting retries on persistent 429', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('rate limited', { status: 429 }))
    const sleepImpl = vi.fn().mockResolvedValue(undefined)

    const pick = await chatJson({
      ...args,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleepImpl,
    })

    expect(pick).toEqual({})
    expect(fetchImpl).toHaveBeenCalledTimes(3)
  })

  it('tolerates surrounding prose around the JSON object', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        openAiResponse(
          'Sure! Here is my pick:\n{"chosen_sku": "sku-2", "reason": "cheap"}\nEnjoy!',
        ),
      )

    const pick = await chatJson({ ...args, fetchImpl: fetchImpl as unknown as typeof fetch })
    expect(pick).toEqual({ chosen_sku: 'sku-2', reason: 'cheap' })
  })

  it('returns {} for junk (non-JSON) content', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(openAiResponse('not json at all'))
    const pick = await chatJson({ ...args, fetchImpl: fetchImpl as unknown as typeof fetch })
    expect(pick).toEqual({})
  })

  it('returns {} when the response has no choices', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ choices: [] }), { status: 200 }))
    const pick = await chatJson({ ...args, fetchImpl: fetchImpl as unknown as typeof fetch })
    expect(pick).toEqual({})
  })

  it('returns {} on a persistent 5xx after retries instead of throwing', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('server error', { status: 500 }))
    const sleepImpl = vi.fn().mockResolvedValue(undefined)
    const pick = await chatJson({
      ...args,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleepImpl,
    })
    expect(pick).toEqual({})
  })

  it('returns {} on a non-retryable client error (e.g. 401) without retrying', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('unauthorized', { status: 401 }))
    const pick = await chatJson({ ...args, fetchImpl: fetchImpl as unknown as typeof fetch })
    expect(pick).toEqual({})
    expect(fetchImpl).toHaveBeenCalledOnce()
  })

  it('returns {} when fetch itself rejects (network error) instead of throwing', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('network down'))
    const sleepImpl = vi.fn().mockResolvedValue(undefined)
    const pick = await chatJson({
      ...args,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleepImpl,
    })
    expect(pick).toEqual({})
  })

  it('strips a trailing slash from baseUrl', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(openAiResponse('{"chosen_sku": "x", "reason": "y"}'))
    await chatJson({
      ...args,
      baseUrl: 'https://api.example.test/v1/',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    const [url] = fetchImpl.mock.calls[0] as [string]
    expect(url).toBe('https://api.example.test/v1/chat/completions')
  })
})
