import { describe, it, expect, beforeAll } from 'vitest'

// NOTE: static `import ... from '../../src/lib/crypto'` at the top of this
// file would be hoisted and evaluated *before* the process.env assignment
// below ever runs (ESM import hoisting) — src/lib/crypto.ts would then see
// an unset DATA_KEY and throw at import time, even in this file's own
// source order. Using beforeAll() + a dynamic import() (same pattern as
// test/unit/env.test.ts's `?bust=` trick) guarantees the env var is set
// before src/env.ts (and therefore src/lib/crypto.ts) is evaluated.
describe('crypto', () => {
  beforeAll(() => {
    process.env.DATA_KEY ||= '0'.repeat(64)
  })

  it('round-trips', async () => {
    const { encrypt, decrypt } = await import('../../src/lib/crypto')
    const p = Buffer.from('hello pdf')
    const c = encrypt(p)
    expect(c.equals(p)).toBe(false)
    expect(decrypt(c).equals(p)).toBe(true)
  })

  it('rejects tampered ciphertext', async () => {
    const { encrypt, decrypt } = await import('../../src/lib/crypto')
    const c = encrypt(Buffer.from('x'))
    c[c.length - 1] ^= 0xff
    expect(() => decrypt(c)).toThrow()
  })
})
