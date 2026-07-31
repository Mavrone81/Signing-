import { describe, it, expect } from 'vitest'
import { sha256hex } from '../../src/lib/hash'
describe('hash', () => {
  it('matches known sha256 vector for "abc"', () => {
    expect(sha256hex(Buffer.from('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
    )
  })
})
