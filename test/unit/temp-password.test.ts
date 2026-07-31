import { describe, it, expect } from 'vitest'
import { generateTempPassword } from '../../src/lib/temp-password'

describe('generateTempPassword', () => {
  it('produces a URL-safe token comfortably above the 8-char signup minimum', () => {
    const pw = generateTempPassword()
    expect(pw.length).toBeGreaterThanOrEqual(16)
    // base64url alphabet only (no +, /, or = padding).
    expect(pw).toMatch(/^[A-Za-z0-9_-]+$/)
  })

  it('is unique across calls (CSPRNG, not a constant)', () => {
    const seen = new Set(Array.from({ length: 200 }, () => generateTempPassword()))
    expect(seen.size).toBe(200)
  })
})
