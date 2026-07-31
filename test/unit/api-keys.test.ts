import { describe, it, expect } from 'vitest'
import { generateApiKey, hashApiKey, looksLikeApiKey, API_KEY_LIVE_PREFIX } from '../../src/lib/api-keys'
import { sha256hex } from '../../src/lib/hash'

describe('api-keys', () => {
  it('generates a sk_live_ key whose hash is sha256(raw) and prefix is its head', () => {
    const k = generateApiKey()
    expect(k.raw.startsWith(API_KEY_LIVE_PREFIX)).toBe(true)
    expect(k.raw.length).toBeGreaterThan(API_KEY_LIVE_PREFIX.length + 20)
    expect(k.hashedKey).toBe(sha256hex(Buffer.from(k.raw, 'utf8')))
    expect(k.hashedKey).toHaveLength(64)
    // prefix is a short, non-secret head of the raw key
    expect(k.raw.startsWith(k.prefix)).toBe(true)
    expect(k.prefix.length).toBeLessThan(k.raw.length)
    // the stored prefix must not be enough to reconstruct/authenticate the key
    expect(hashApiKey(k.prefix)).not.toBe(k.hashedKey)
  })

  it('mints unique keys', () => {
    const seen = new Set(Array.from({ length: 50 }, () => generateApiKey().raw))
    expect(seen.size).toBe(50)
  })

  it('hashApiKey is deterministic', () => {
    expect(hashApiKey('sk_live_abc')).toBe(hashApiKey('sk_live_abc'))
    expect(hashApiKey('sk_live_abc')).not.toBe(hashApiKey('sk_live_abd'))
  })

  it('looksLikeApiKey rejects non-keys', () => {
    expect(looksLikeApiKey(generateApiKey().raw)).toBe(true)
    expect(looksLikeApiKey('')).toBe(false)
    expect(looksLikeApiKey('bearer xyz')).toBe(false)
    expect(looksLikeApiKey('sk_live_')).toBe(false)
    expect(looksLikeApiKey('sk_test_short')).toBe(false)
  })
})
