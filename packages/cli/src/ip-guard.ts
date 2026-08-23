/**
 * IP-literal classification for the scanner's SSRF guard. The scanner fetches
 * URLs supplied by whoever runs `hundi init`, so every resolved address has
 * to be checked against loopback/private/link-local ranges before the
 * request goes out — a malicious `catalog_url` pointing at `169.254.169.254`
 * or a bare `127.0.0.1` must never reach `fetch`.
 */

function isPrivateIpv4(address: string): boolean {
  const parts = address.split('.')
  if (parts.length !== 4) return true // not a well-formed IPv4 literal — treat as unsafe

  const octets = parts.map((part) => Number.parseInt(part, 10))
  if (octets.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return true

  const [a, b] = octets as [number, number, number, number]
  if (a === 127) return true // loopback 127.0.0.0/8
  if (a === 10) return true // private 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true // private 172.16.0.0/12
  if (a === 192 && b === 168) return true // private 192.168.0.0/16
  if (a === 169 && b === 254) return true // link-local 169.254.0.0/16
  if (a === 0) return true // "this network" 0.0.0.0/8
  return false
}

function isPrivateIpv6(address: string): boolean {
  const normalized = address.toLowerCase()
  if (normalized === '::1') return true // loopback

  // IPv4-mapped IPv6 (::ffff:a.b.c.d) — classify the embedded IPv4 address.
  const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
  if (mapped?.[1]) return isPrivateIpv4(mapped[1])

  const firstGroup = normalized.split(':')[0] ?? ''
  const firstHex = Number.parseInt(firstGroup, 16)
  if (Number.isNaN(firstHex)) return true // malformed — treat as unsafe

  if (firstHex >= 0xfc00 && firstHex <= 0xfdff) return true // unique local fc00::/7
  if (firstHex >= 0xfe80 && firstHex <= 0xfebf) return true // link-local fe80::/10
  return false
}

/** True for loopback, RFC1918/RFC4193 private, and link-local addresses (v4 and v6),
 * plus anything that fails to parse as a well-formed IP literal. Fail-closed: an
 * address we can't classify is treated as unsafe rather than allowed through. */
export function isPrivateOrLoopbackIp(address: string): boolean {
  return address.includes(':') ? isPrivateIpv6(address) : isPrivateIpv4(address)
}
