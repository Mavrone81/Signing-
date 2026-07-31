import { describe, it, expect } from 'vitest'
describe('env', () => {
  it('throws when DATA_KEY missing', async () => {
    const prev = process.env.DATA_KEY; delete process.env.DATA_KEY
    await expect(import('../../src/env?bust=' + Date.now())).rejects.toThrow(/DATA_KEY/)
    process.env.DATA_KEY = prev
  })
})
