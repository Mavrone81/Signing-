import { describe, it, expect } from 'vitest'
import { normToPdfRect, clamp01, clampFieldRect } from '../../src/lib/coords'

describe('clamp01', () => {
  it('passes through values already in [0,1]', () => {
    expect(clamp01(0)).toBe(0)
    expect(clamp01(0.5)).toBe(0.5)
    expect(clamp01(1)).toBe(1)
  })
  it('clamps out-of-range values to the nearest bound', () => {
    expect(clamp01(-0.3)).toBe(0)
    expect(clamp01(1.7)).toBe(1)
  })
  it('treats NaN as 0', () => {
    expect(clamp01(Number.NaN)).toBe(0)
  })
})

describe('clampFieldRect', () => {
  it('leaves an in-bounds rect unchanged', () => {
    const r = clampFieldRect({ x: 0.2, y: 0.3, w: 0.1, h: 0.1 })
    expect(r).toEqual({ x: 0.2, y: 0.3, w: 0.1, h: 0.1 })
  })
  it('pushes a rect back inside when it would overflow the right/bottom edge', () => {
    const r = clampFieldRect({ x: 0.95, y: 0.98, w: 0.2, h: 0.1 })
    // x + w and y + h must not exceed 1
    expect(r.x + r.w).toBeCloseTo(1)
    expect(r.y + r.h).toBeCloseTo(1)
    expect(r.x).toBeCloseTo(0.8)
    expect(r.y).toBeCloseTo(0.9)
  })
  it('clamps negative origins to 0', () => {
    const r = clampFieldRect({ x: -0.5, y: -0.2, w: 0.1, h: 0.1 })
    expect(r.x).toBe(0)
    expect(r.y).toBe(0)
  })
  it('enforces the minimum size and caps size at 1', () => {
    expect(clampFieldRect({ x: 0, y: 0, w: 0.001, h: 0.001 }, 0.02).w).toBeCloseTo(0.02)
    const big = clampFieldRect({ x: 0, y: 0, w: 5, h: 5 })
    expect(big.w).toBe(1)
    expect(big.h).toBe(1)
  })
})

describe('normToPdfRect', () => {
  it('maps top-left normalized to bottom-left pdf points', () => {
    // field at top-left 10% margin, 20% wide, 5% tall on a 600x800 page
    const r = normToPdfRect({ x: 0.1, y: 0.1, w: 0.2, h: 0.05 }, { width: 600, height: 800 })
    expect(r.x).toBeCloseTo(60) // 0.1*600
    expect(r.width).toBeCloseTo(120) // 0.2*600
    expect(r.height).toBeCloseTo(40) // 0.05*800
    // top-left y=0.1 -> pdf y = height - (y+h)*height = 800 - 0.15*800 = 680
    expect(r.y).toBeCloseTo(680)
  })

  it('places a field flush at the normalized top near the page-height top, minus its height', () => {
    // field at the very top of the page (y=0), 10% tall, on a 600x800 page
    const r = normToPdfRect({ x: 0, y: 0, w: 0.3, h: 0.1 }, { width: 600, height: 800 })
    // top edge in pdf points is page.height (800); bottom edge (r.y) is height minus field height in points
    expect(r.y + r.height).toBeCloseTo(800)
    expect(r.y).toBeCloseTo(800 - 0.1 * 800)
  })

  it('round-trips a mid-page point back to its normalized origin', () => {
    const field = { x: 0.25, y: 0.4, w: 0.3, h: 0.1 }
    const page = { width: 612, height: 792 }
    const r = normToPdfRect(field, page)
    // invert: recover normalized top-left from the pdf rect
    const recoveredX = r.x / page.width
    const recoveredW = r.width / page.width
    const recoveredH = r.height / page.height
    const recoveredY = page.height - r.y - r.height
    expect(recoveredX).toBeCloseTo(field.x)
    expect(recoveredY / page.height).toBeCloseTo(field.y)
    expect(recoveredW).toBeCloseTo(field.w)
    expect(recoveredH).toBeCloseTo(field.h)
  })

  it('places a field flush at the normalized bottom at pdf y=0', () => {
    // field whose bottom touches the normalized bottom edge (y+h=1)
    const r = normToPdfRect({ x: 0.1, y: 0.8, w: 0.2, h: 0.2 }, { width: 600, height: 800 })
    expect(r.y).toBeCloseTo(0)
  })
})
