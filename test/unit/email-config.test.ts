import { describe, it, expect, beforeAll } from 'vitest'

// Dynamic import (same pattern as auth-providers.test.ts): email-config pulls in
// src/lib/crypto → src/env, which reads DATA_KEY at module-eval time. The vitest
// setup file sets a fake DATA_KEY before any test module loads. We exercise only
// the pure helpers + the SMTP-password encrypt/decrypt round-trip (no DB).
type Mod = typeof import('../../src/lib/email-config')
let m: Mod

describe('email-config', () => {
  beforeAll(async () => {
    process.env.DATA_KEY ||= '0'.repeat(64)
    m = await import('../../src/lib/email-config')
  })

  describe('password encrypt/decrypt round-trip', () => {
    it('round-trips an SMTP password', () => {
      const pw = 'super-secret-smtp-pw-123'
      const enc = m.encryptSecret(pw)
      expect(enc).not.toBe(pw)
      expect(enc).not.toContain(pw)
      expect(m.decryptSecret(enc)).toBe(pw)
    })

    it('produces different ciphertext each call (random IV) but the same plaintext', () => {
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

  describe('emailIsConfigured (pure gate)', () => {
    const base = { enabled: true, host: 'smtp.x.com', port: 587, fromEmail: 'a@x.com' }
    it('true only when enabled AND host AND port AND fromEmail', () => {
      expect(m.emailIsConfigured(base)).toBe(true)
    })
    it('false when disabled', () => {
      expect(m.emailIsConfigured({ ...base, enabled: false })).toBe(false)
    })
    it('false when host / port / fromEmail is missing', () => {
      expect(m.emailIsConfigured({ ...base, host: null })).toBe(false)
      expect(m.emailIsConfigured({ ...base, port: null })).toBe(false)
      expect(m.emailIsConfigured({ ...base, fromEmail: null })).toBe(false)
    })
    it('false for null / undefined', () => {
      expect(m.emailIsConfigured(null)).toBe(false)
      expect(m.emailIsConfigured(undefined)).toBe(false)
    })
  })

  describe('pickEmailConfig (org server with shared fallback)', () => {
    type Row = { enabled: boolean; host: string | null; port: number | null; fromEmail: string | null }
    const org: Row = { enabled: true, host: 'smtp.org.com', port: 587, fromEmail: 'org@org.com' }
    const shared: Row = { enabled: true, host: 'smtp.shared.com', port: 587, fromEmail: 'no-reply@shared.com' }
    it('uses the org’s own server when it is usable', () => {
      expect(m.pickEmailConfig(org, shared)).toEqual({ row: org, via: 'org' })
    })
    it('falls back to the shared server when the org has no row', () => {
      expect(m.pickEmailConfig(null, shared)).toEqual({ row: shared, via: 'shared' })
    })
    it('falls back when the org’s server is switched off', () => {
      expect(m.pickEmailConfig({ ...org, enabled: false }, shared)).toEqual({ row: shared, via: 'shared' })
    })
    it('falls back when the org’s server is incomplete', () => {
      expect(m.pickEmailConfig({ ...org, fromEmail: null }, shared)).toEqual({ row: shared, via: 'shared' })
    })
    it('still uses the org’s own server when the shared one is off', () => {
      expect(m.pickEmailConfig(org, { ...shared, enabled: false })).toEqual({ row: org, via: 'org' })
    })
    it('returns null when neither is usable, so nothing is sent', () => {
      expect(m.pickEmailConfig(null, null)).toBeNull()
      expect(m.pickEmailConfig({ ...org, enabled: false }, { ...shared, enabled: false })).toBeNull()
    })
  })
})
