import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'

/** SHA-256 of `bytes`, hex-encoded (lowercase). */
export function sha256Hex(bytes: Uint8Array): string {
  return bytesToHex(sha256(bytes))
}

// No '=' padding, '+' -> '-', '/' -> '_', per RFC 4648 §5. Implemented by hand
// (rather than atob/btoa or Buffer) so this module runs identically in
// browsers and Node without a runtime-specific base64 primitive.
const BASE64URL_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'

function bytesToBase64Url(bytes: Uint8Array): string {
  let out = ''
  let i = 0
  for (; i + 3 <= bytes.length; i += 3) {
    const b0 = bytes[i] as number
    const b1 = bytes[i + 1] as number
    const b2 = bytes[i + 2] as number
    out += BASE64URL_CHARS[b0 >> 2]
    out += BASE64URL_CHARS[((b0 & 0x03) << 4) | (b1 >> 4)]
    out += BASE64URL_CHARS[((b1 & 0x0f) << 2) | (b2 >> 6)]
    out += BASE64URL_CHARS[b2 & 0x3f]
  }
  const remaining = bytes.length - i
  if (remaining === 1) {
    const b0 = bytes[i] as number
    out += BASE64URL_CHARS[b0 >> 2]
    out += BASE64URL_CHARS[(b0 & 0x03) << 4]
  } else if (remaining === 2) {
    const b0 = bytes[i] as number
    const b1 = bytes[i + 1] as number
    out += BASE64URL_CHARS[b0 >> 2]
    out += BASE64URL_CHARS[((b0 & 0x03) << 4) | (b1 >> 4)]
    out += BASE64URL_CHARS[(b1 & 0x0f) << 2]
  }
  return out
}

function base64UrlToBytes(input: string): Uint8Array {
  const clean = input.replace(/-/g, '+').replace(/_/g, '/')
  const padLen = (4 - (clean.length % 4)) % 4
  const padded = clean + '='.repeat(padLen)
  const binary = globalThis.atob(padded)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/** SHA-256 of `bytes`, base64url-encoded (no padding). */
export function sha256B64url(bytes: Uint8Array): string {
  return bytesToBase64Url(sha256(bytes))
}

/** Decodes a base64url string (as emitted by WebAuthn) to raw bytes. */
export function decodeBase64Url(input: string): Uint8Array {
  return base64UrlToBytes(input)
}
