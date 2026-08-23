/**
 * Deterministic JSON serialization: object keys sorted lexicographically, no
 * whitespace, UTF-8 bytes. Two callers (browser, Node) that canonicalize the
 * same logical value MUST produce byte-identical output — this is what makes
 * a hash or signature over the result portable across runtimes.
 *
 * The leaf type is deliberately narrow (safe integers, strings, booleans,
 * null). Floats, -0, NaN/Infinity, bigint, undefined, and functions have no
 * single canonical textual form across JS engines, so they're rejected
 * rather than serialized ambiguously.
 */

export type CanonicalValue =
  | string
  | number
  | boolean
  | null
  | readonly CanonicalValue[]
  | { readonly [key: string]: CanonicalValue }

function assertCanonicalLeaf(value: unknown, path: string): void {
  if (value === null) return
  const t = typeof value
  if (t === 'boolean' || t === 'string') return
  if (t === 'number') {
    if (Number.isNaN(value as number) || !Number.isFinite(value as number)) {
      throw new TypeError(`canonicalJson: non-finite number at ${path}`)
    }
    if (!Number.isInteger(value as number)) {
      throw new TypeError(`canonicalJson: non-integer number at ${path}`)
    }
    if (!Number.isSafeInteger(value as number)) {
      throw new TypeError(`canonicalJson: unsafe integer at ${path}`)
    }
    if (Object.is(value, -0)) {
      throw new TypeError(`canonicalJson: -0 is not canonical at ${path}`)
    }
    return
  }
  if (t === 'bigint') throw new TypeError(`canonicalJson: bigint not allowed at ${path}`)
  if (t === 'undefined') throw new TypeError(`canonicalJson: undefined not allowed at ${path}`)
  if (t === 'function') throw new TypeError(`canonicalJson: function not allowed at ${path}`)
  if (Array.isArray(value)) return
  if (t === 'object') return
  throw new TypeError(`canonicalJson: unsupported value at ${path}`)
}

function encode(value: unknown, path: string): string {
  assertCanonicalLeaf(value, path)
  if (value === null || typeof value === 'boolean' || typeof value === 'number') {
    return JSON.stringify(value)
  }
  if (typeof value === 'string') return JSON.stringify(value)
  if (Array.isArray(value)) {
    return `[${value.map((v, i) => encode(v, `${path}[${i}]`)).join(',')}]`
  }
  // Plain object: sort keys lexicographically by UTF-16 code unit (String#sort default).
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  const entries = keys.map((k) => {
    const v = obj[k]
    if (v === undefined) throw new TypeError(`canonicalJson: undefined not allowed at ${path}.${k}`)
    return `${JSON.stringify(k)}:${encode(v, `${path}.${k}`)}`
  })
  return `{${entries.join(',')}}`
}

/** Serializes `value` to canonical JSON bytes. Throws on any non-canonical leaf (see module doc). */
export function canonicalJson(value: CanonicalValue): Uint8Array {
  const json = encode(value, '$')
  return new TextEncoder().encode(json)
}
