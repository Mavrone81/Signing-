import { describe, it, expect, beforeAll } from 'vitest'
import type { Session } from 'next-auth'

// Dynamic import (same pattern as crypto.test.ts): src/lib/auth-providers pulls
// in src/lib/crypto → src/env, which reads DATA_KEY at module-eval time. The
// vitest setup file sets a fake DATA_KEY before any test module loads; the
// beforeAll ||= is a belt-and-braces guarantee. We never touch the DB here —
// only the pure helpers + the string secret encrypt/decrypt are exercised.
type Mod = typeof import('../../src/lib/auth-providers')
let m: Mod

describe('auth-providers', () => {
  beforeAll(async () => {
    process.env.DATA_KEY ||= '0'.repeat(64)
    m = await import('../../src/lib/auth-providers')
  })

  describe('secret encrypt/decrypt round-trip', () => {
    it('round-trips a client secret', () => {
      const secret = 'GOCSPX-super-secret-value-123'
      const enc = m.encryptSecret(secret)
      expect(enc).not.toBe(secret)
      expect(enc).not.toContain(secret)
      expect(m.decryptSecret(enc)).toBe(secret)
    })

    it('produces different ciphertext each call (random IV) but same plaintext', () => {
      const a = m.encryptSecret('same')
      const b = m.encryptSecret('same')
      expect(a).not.toBe(b)
      expect(m.decryptSecret(a)).toBe('same')
      expect(m.decryptSecret(b)).toBe('same')
    })

    it('rejects tampered ciphertext (GCM auth tag)', () => {
      const enc = m.encryptSecret('x')
      const buf = Buffer.from(enc, 'base64')
      buf[buf.length - 1] ^= 0xff
      expect(() => m.decryptSecret(buf.toString('base64'))).toThrow()
    })
  })

  describe('providerIsConfigured', () => {
    it('true only when enabled AND has clientId AND has secret', () => {
      expect(m.providerIsConfigured({ enabled: true, clientId: 'id', clientSecretEnc: 'sec' })).toBe(true)
    })
    it('false when disabled', () => {
      expect(m.providerIsConfigured({ enabled: false, clientId: 'id', clientSecretEnc: 'sec' })).toBe(false)
    })
    it('false when missing clientId or secret', () => {
      expect(m.providerIsConfigured({ enabled: true, clientId: null, clientSecretEnc: 'sec' })).toBe(false)
      expect(m.providerIsConfigured({ enabled: true, clientId: 'id', clientSecretEnc: null })).toBe(false)
    })
  })

  describe('selectUsableProviders (enabled-providers helper)', () => {
    it('returns only enabled + fully-configured known providers', () => {
      const rows = [
        { provider: 'google', enabled: true, clientId: 'g', clientSecretEnc: 's', tenantId: null },
        { provider: 'microsoft', enabled: true, clientId: 'm', clientSecretEnc: null, tenantId: 'common' }, // no secret
      ]
      expect(m.selectUsableProviders(rows)).toEqual(['google'])
    })
    it('ignores disabled rows and unknown providers', () => {
      const rows = [
        { provider: 'google', enabled: false, clientId: 'g', clientSecretEnc: 's', tenantId: null },
        { provider: 'github', enabled: true, clientId: 'x', clientSecretEnc: 's', tenantId: null },
        { provider: 'microsoft', enabled: true, clientId: 'm', clientSecretEnc: 's', tenantId: 'common' },
      ]
      expect(m.selectUsableProviders(rows)).toEqual(['microsoft'])
    })
    it('returns [] when nothing is configured', () => {
      expect(m.selectUsableProviders([])).toEqual([])
    })
  })

  describe('isPlatformAdmin gate', () => {
    const base = { id: 'u1', email: 'a@b.com', role: 'user' as const, orgId: null, orgRole: null }
    it('true only for a session whose user.isPlatformAdmin === true', () => {
      expect(m.isPlatformAdmin({ user: { ...base, isPlatformAdmin: true } } as Session)).toBe(true)
    })
    it('false for a non-admin user', () => {
      expect(m.isPlatformAdmin({ user: { ...base, isPlatformAdmin: false } } as Session)).toBe(false)
    })
    it('false for null / undefined session', () => {
      expect(m.isPlatformAdmin(null)).toBe(false)
      expect(m.isPlatformAdmin(undefined)).toBe(false)
    })
  })
})
