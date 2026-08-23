import { describe, expect, it } from 'vitest'
import { canonicalJson } from '../canonical-json.js'
import { sha256Hex } from '../hash.js'

describe('canonicalJson', () => {
  it('sorts object keys lexicographically at every depth', () => {
    const bytes = canonicalJson({ b: 2, a: 1, nested: { z: 'hi', arr: [1, 2, 3] } })
    expect(new TextDecoder().decode(bytes)).toBe('{"a":1,"b":2,"nested":{"arr":[1,2,3],"z":"hi"}}')
  })

  it('preserves array order', () => {
    const bytes = canonicalJson({ list: [3, 1, 2] })
    expect(new TextDecoder().decode(bytes)).toBe('{"list":[3,1,2]}')
  })

  it('is invariant to input key order', () => {
    const a = canonicalJson({ x: 1, y: 2 })
    const b = canonicalJson({ y: 2, x: 1 })
    expect(a).toEqual(b)
  })

  // Golden hash: catches any future drift in encode() that would desync a browser build
  // from a Node build, since both are supposed to hash this object identically.
  it('golden fixture: fixed object hashes to a fixed sha256 hex', () => {
    const bytes = canonicalJson({ b: 2, a: 1, nested: { z: 'hi', arr: [1, 2, 3] } })
    expect(sha256Hex(bytes)).toBe(
      'dacac66719b0b35984bbdd0970e3a79a0aeb2a44275ab5e69b1de1ffd333f9e3',
    )
  })

  it('throws on non-integer numbers', () => {
    expect(() => canonicalJson({ x: 1.5 })).toThrow(TypeError)
  })

  it('throws on -0', () => {
    expect(() => canonicalJson({ x: -0 })).toThrow(TypeError)
  })

  it('throws on NaN', () => {
    expect(() => canonicalJson({ x: Number.NaN })).toThrow(TypeError)
  })

  it('throws on Infinity', () => {
    expect(() => canonicalJson({ x: Number.POSITIVE_INFINITY })).toThrow(TypeError)
  })

  it('throws on unsafe integers', () => {
    expect(() => canonicalJson({ x: Number.MAX_SAFE_INTEGER + 1 })).toThrow(TypeError)
  })

  it('throws on undefined leaves', () => {
    expect(() => canonicalJson({ x: undefined as unknown as null })).toThrow(TypeError)
  })

  it('throws on bigint leaves', () => {
    expect(() => canonicalJson({ x: 1n as unknown as number })).toThrow(TypeError)
  })

  it('accepts null, booleans, strings, integers, nested arrays and objects', () => {
    const bytes = canonicalJson({ a: null, b: true, c: false, d: 'x', e: 0, f: [null, 1] })
    expect(new TextDecoder().decode(bytes)).toBe(
      '{"a":null,"b":true,"c":false,"d":"x","e":0,"f":[null,1]}',
    )
  })
})
