import { describe, it, expect, beforeEach } from 'vitest'
import {
  clientIp,
  loginKey,
  isBlocked,
  recordFailure,
  clearFailures,
  sweep,
  __resetForTests,
  LOGIN_WINDOW_MS,
  LOGIN_MAX_FAILS,
} from '../../src/lib/login-throttle'

const headers = (h: Record<string, string>) => ({
  get: (name: string) => h[name.toLowerCase()] ?? null,
})

beforeEach(() => __resetForTests())

describe('clientIp', () => {
  it('prefers X-Real-IP, which nginx replaces and a caller cannot set', () => {
    expect(clientIp(headers({ 'x-real-ip': '203.0.113.9' }))).toBe('203.0.113.9')
  })

  it('ignores a forged first X-Forwarded-For entry and takes the last', () => {
    // This is the whole point. nginx appends the real peer with
    // $proxy_add_x_forwarded_for, so the FIRST entry is whatever the caller
    // sent. Reading it would let an attacker pick a new throttle key per
    // request and never trip the limit.
    expect(clientIp(headers({ 'x-forwarded-for': '1.2.3.4, 198.51.100.7' }))).toBe('198.51.100.7')
  })

  it('falls back to unknown when no forwarding header is present', () => {
    expect(clientIp(headers({}))).toBe('unknown')
  })
})

describe('loginKey', () => {
  it('separates two accounts from the same address', () => {
    expect(loginKey('a@x.com', '1.1.1.1')).not.toBe(loginKey('b@x.com', '1.1.1.1'))
  })

  it('separates one account seen from two addresses', () => {
    expect(loginKey('a@x.com', '1.1.1.1')).not.toBe(loginKey('a@x.com', '2.2.2.2'))
  })

  it('normalises case and surrounding space so they cannot split the count', () => {
    expect(loginKey('  A@X.com ', '1.1.1.1')).toBe(loginKey('a@x.com', '1.1.1.1'))
  })
})

describe('failure counting', () => {
  it('blocks only after the fifth failure', () => {
    const k = loginKey('a@x.com', '1.1.1.1')
    for (let i = 0; i < LOGIN_MAX_FAILS - 1; i++) {
      recordFailure(k)
      expect(isBlocked(k)).toBe(false)
    }
    recordFailure(k)
    expect(isBlocked(k)).toBe(true)
  })

  it('does not touch a different account at the same address', () => {
    const mine = loginKey('victim@x.com', '1.1.1.1')
    const other = loginKey('someone@x.com', '1.1.1.1')
    for (let i = 0; i < LOGIN_MAX_FAILS; i++) recordFailure(mine)
    expect(isBlocked(mine)).toBe(true)
    expect(isBlocked(other)).toBe(false)
  })

  it('clears on success so a mistyped password is not held against you', () => {
    const k = loginKey('a@x.com', '1.1.1.1')
    for (let i = 0; i < LOGIN_MAX_FAILS; i++) recordFailure(k)
    expect(isBlocked(k)).toBe(true)
    clearFailures(k)
    expect(isBlocked(k)).toBe(false)
  })

  it('releases the block once the window passes', () => {
    const t0 = 1_000_000
    const k = loginKey('a@x.com', '1.1.1.1')
    for (let i = 0; i < LOGIN_MAX_FAILS; i++) recordFailure(k, t0)
    expect(isBlocked(k, t0)).toBe(true)
    expect(isBlocked(k, t0 + LOGIN_WINDOW_MS + 1)).toBe(false)
  })

  it('starts a lapsed window again at one rather than resuming at the cap', () => {
    // A counter that never resets turns a 15-minute lock into a permanent one:
    // the next single failure after expiry would re-trip it immediately.
    const t0 = 1_000_000
    const k = loginKey('a@x.com', '1.1.1.1')
    for (let i = 0; i < LOGIN_MAX_FAILS; i++) recordFailure(k, t0)
    const later = t0 + LOGIN_WINDOW_MS + 1
    recordFailure(k, later)
    expect(isBlocked(k, later)).toBe(false)
  })

  it('sweeps expired entries so the map cannot grow without bound', () => {
    const t0 = 1_000_000
    recordFailure(loginKey('a@x.com', '1.1.1.1'), t0)
    sweep(t0 + LOGIN_WINDOW_MS + 1)
    expect(isBlocked(loginKey('a@x.com', '1.1.1.1'), t0 + LOGIN_WINDOW_MS + 1)).toBe(false)
  })
})
