import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ScanError, safeFetch } from '../scanner.js'

const originalFetch = globalThis.fetch

function publicResolver() {
  return async () => [{ address: '93.184.216.34', family: 4 }]
}

function privateResolver(address: string) {
  return async () => [{ address, family: address.includes(':') ? 6 : 4 }]
}

describe('safeFetch', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('rejects a hostname that resolves to a loopback address', async () => {
    const mockFetch = vi.fn()
    globalThis.fetch = mockFetch as unknown as typeof fetch

    await expect(
      safeFetch('http://internal.example.com/', { resolver: privateResolver('127.0.0.1') }),
    ).rejects.toThrow(ScanError)
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('rejects a hostname that resolves to a private IPv4 address', async () => {
    const mockFetch = vi.fn()
    globalThis.fetch = mockFetch as unknown as typeof fetch

    await expect(
      safeFetch('http://internal.example.com/', { resolver: privateResolver('10.0.0.5') }),
    ).rejects.toThrow(/private\/loopback/)
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('rejects a link-local IPv6 address (e.g. cloud metadata via v6)', async () => {
    const mockFetch = vi.fn()
    globalThis.fetch = mockFetch as unknown as typeof fetch

    await expect(
      safeFetch('http://internal.example.com/', { resolver: privateResolver('fe80::1') }),
    ).rejects.toThrow(ScanError)
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('rejects non-http(s) protocols before attempting to resolve', async () => {
    const resolver = vi.fn(publicResolver())
    const mockFetch = vi.fn()
    globalThis.fetch = mockFetch as unknown as typeof fetch

    await expect(safeFetch('ftp://shop.example.com/', { resolver })).rejects.toThrow(/non-http/)
    expect(resolver).not.toHaveBeenCalled()
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('allows a hostname that resolves to a public address', async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValue(
        new Response('<html>ok</html>', { status: 200, headers: { 'content-type': 'text/html' } }),
      )
    globalThis.fetch = mockFetch as unknown as typeof fetch

    const result = await safeFetch('https://shop.example.com/', { resolver: publicResolver() })
    expect(result.text).toBe('<html>ok</html>')
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  it('follows redirects manually, re-checking each hop, up to the cap', async () => {
    const resolver = vi.fn(publicResolver())
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: 'https://shop.example.com/final' },
        }),
      )
      .mockResolvedValueOnce(new Response('final page', { status: 200 }))
    globalThis.fetch = mockFetch as unknown as typeof fetch

    const result = await safeFetch('https://shop.example.com/start', { resolver, maxRedirects: 5 })
    expect(result.text).toBe('final page')
    expect(result.finalUrl).toBe('https://shop.example.com/final')
    expect(resolver).toHaveBeenCalledTimes(2)
  })

  it('throws once redirects exceed the configured cap', async () => {
    const resolver = vi.fn(publicResolver())
    const mockFetch = vi
      .fn()
      .mockResolvedValue(
        new Response(null, { status: 302, headers: { location: 'https://shop.example.com/loop' } }),
      )
    globalThis.fetch = mockFetch as unknown as typeof fetch

    await expect(
      safeFetch('https://shop.example.com/loop', { resolver, maxRedirects: 2 }),
    ).rejects.toThrow(/too many redirects/)
  })

  it('rejects a response body larger than the configured cap', async () => {
    const bigBody = 'x'.repeat(100)
    const mockFetch = vi.fn().mockResolvedValue(new Response(bigBody, { status: 200 }))
    globalThis.fetch = mockFetch as unknown as typeof fetch

    await expect(
      safeFetch('https://shop.example.com/', { resolver: publicResolver(), maxBodyBytes: 10 }),
    ).rejects.toThrow(/byte cap/)
  })

  it('surfaces a clear error when the hostname cannot be resolved at all', async () => {
    const mockFetch = vi.fn()
    globalThis.fetch = mockFetch as unknown as typeof fetch
    const resolver = async () => {
      throw new Error('ENOTFOUND')
    }

    await expect(safeFetch('https://nowhere.invalid/', { resolver })).rejects.toThrow(
      /could not resolve/,
    )
    expect(mockFetch).not.toHaveBeenCalled()
  })
})
