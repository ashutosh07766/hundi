import { describe, expect, it } from 'vitest'
import { formatPaise, paiseToRupees, rupeesToPaise } from '../lib/format.js'

describe('paiseToRupees', () => {
  it('divides paise by 100', () => {
    expect(paiseToRupees(320000)).toBe(3200)
    expect(paiseToRupees(150)).toBe(1.5)
    expect(paiseToRupees(0)).toBe(0)
  })
})

describe('rupeesToPaise', () => {
  it('multiplies rupees by 100 and rounds', () => {
    expect(rupeesToPaise(3200)).toBe(320000)
    expect(rupeesToPaise(1.5)).toBe(150)
  })

  it('rounds away floating-point noise', () => {
    expect(rupeesToPaise(19.99)).toBe(1999)
  })
})

describe('formatPaise', () => {
  it('formats whole rupees with Indian digit grouping', () => {
    expect(formatPaise(320000)).toBe('₹3,200.00')
    expect(formatPaise(15000000)).toBe('₹1,50,000.00')
  })

  it('formats fractional rupees', () => {
    expect(formatPaise(320050)).toBe('₹3,200.50')
  })

  it('formats zero', () => {
    expect(formatPaise(0)).toBe('₹0.00')
  })
})
