import { bytesToHex } from '@noble/hashes/utils.js'
import { describe, expect, it } from 'vitest'
import { decodeBase64Url, sha256B64url, sha256Hex } from '../hash.js'

describe('hash', () => {
  const bytes = new TextEncoder().encode('hundi')
  const KNOWN_DIGEST_HEX = '023e6633577d4f4aeae7fd64623259e99d3b180e71531c87b56377061dc7e59a'

  it('sha256Hex produces a known digest', () => {
    // Verified independently via `printf hundi | shasum -a 256`.
    expect(sha256Hex(bytes)).toBe(KNOWN_DIGEST_HEX)
  })

  it('sha256B64url decodes back to the same digest bytes as sha256Hex', () => {
    const b64 = sha256B64url(bytes)
    expect(b64).not.toMatch(/[+/=]/)
    const decoded = decodeBase64Url(b64)
    expect(bytesToHex(decoded)).toBe(KNOWN_DIGEST_HEX)
  })
})
