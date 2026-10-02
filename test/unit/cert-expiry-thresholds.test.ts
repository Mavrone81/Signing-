// @vitest-environment node
//
// Sign #11: pure threshold logic. This feature IS its boundaries, so the
// whole suite is boundary-dense per-day, with an INJECTED `now` (never a
// global Date mock) — this feature IS its boundaries. Must-fire and
// must-NOT-fire cases are both first-class: a silent day is as load-bearing
// as a firing one.
import { describe, it, expect } from 'vitest'
import {
  THRESHOLD_DAYS,
  isThresholdEligible,
  hasThresholdCrossed,
  dueThresholds,
} from '../../src/server/notifications/cert-expiry-thresholds'

const DAY_MS = 86_400_000
const NOW = new Date('2026-10-02T00:00:00.000Z')
const daysOut = (n: number) => new Date(NOW.getTime() + n * DAY_MS)
const LONG_AGO = new Date(NOW.getTime() - 400 * DAY_MS)

describe('THRESHOLD_DAYS reuses EXPIRY_WARNING_DAYS, not a second constant', () => {
  it('is exactly [30, 7, 1, 0]', () => {
    expect(THRESHOLD_DAYS).toEqual([30, 7, 1, 0])
  })
})

describe('hasThresholdCrossed: dense per-day sampling, both directions', () => {
  it('day 31 vs threshold 30: false (must-not-fire)', () => {
    expect(hasThresholdCrossed(daysOut(31), 30, NOW)).toBe(false)
  })
  it('day 30 vs threshold 30: true (exact boundary)', () => {
    expect(hasThresholdCrossed(daysOut(30), 30, NOW)).toBe(true)
  })
  it('day 29 vs threshold 30: true', () => {
    expect(hasThresholdCrossed(daysOut(29), 30, NOW)).toBe(true)
  })
  it('day 8 vs threshold 7: false (must-not-fire)', () => {
    expect(hasThresholdCrossed(daysOut(8), 7, NOW)).toBe(false)
  })
  it('day 7 vs threshold 7: true', () => {
    expect(hasThresholdCrossed(daysOut(7), 7, NOW)).toBe(true)
  })
  it('day 2 vs threshold 1: false (must-not-fire)', () => {
    expect(hasThresholdCrossed(daysOut(2), 1, NOW)).toBe(false)
  })
  it('day 1 vs threshold 1: true', () => {
    expect(hasThresholdCrossed(daysOut(1), 1, NOW)).toBe(true)
  })
  it('day 0 vs threshold 0: true (expiry day)', () => {
    expect(hasThresholdCrossed(daysOut(0), 0, NOW)).toBe(true)
  })
  it('day -1 (already expired) vs threshold 0: true', () => {
    expect(hasThresholdCrossed(daysOut(-1), 0, NOW)).toBe(true)
  })

  it('threshold 0 is EXACTLY isCertificateExpired, not a parallel reimplementation', async () => {
    const { isCertificateExpired } = await import('../../src/lib/pki')
    for (const days of [1, 0, -1]) {
      expect(hasThresholdCrossed(daysOut(days), 0, NOW)).toBe(isCertificateExpired(daysOut(days), NOW))
    }
  })
})

describe('isThresholdEligible: skip thresholds already past at cert creation', () => {
  it('a cert created with 5 days left is NOT eligible for the 30- or 7-day thresholds', () => {
    const cert = { notAfter: daysOut(5), createdAt: NOW }
    expect(isThresholdEligible(cert, 30)).toBe(false)
    expect(isThresholdEligible(cert, 7)).toBe(false)
  })

  it('that same cert IS eligible for the 1-day and expiry-day thresholds', () => {
    const cert = { notAfter: daysOut(5), createdAt: NOW }
    expect(isThresholdEligible(cert, 1)).toBe(true)
    expect(isThresholdEligible(cert, 0)).toBe(true)
  })

  it('a cert created with 45 days left is eligible for every threshold', () => {
    const cert = { notAfter: daysOut(45), createdAt: NOW }
    for (const t of THRESHOLD_DAYS) expect(isThresholdEligible(cert, t)).toBe(true)
  })

  it('a long-lived cert approaching expiry is eligible for every threshold (the normal case)', () => {
    const cert = { notAfter: daysOut(7), createdAt: LONG_AGO }
    for (const t of THRESHOLD_DAYS) expect(isThresholdEligible(cert, t)).toBe(true)
  })
})

describe('dueThresholds: eligibility AND crossing combined', () => {
  it('a long-lived cert at exactly 30 days out is due for [30] only', () => {
    expect(dueThresholds({ notAfter: daysOut(30), createdAt: LONG_AGO }, NOW)).toEqual([30])
  })

  it('a long-lived cert at exactly 7 days out is due for [30, 7] (30 was already crossed, not yet acknowledged by this layer)', () => {
    expect(dueThresholds({ notAfter: daysOut(7), createdAt: LONG_AGO }, NOW)).toEqual([30, 7])
  })

  it('a long-lived cert at exactly 1 day out is due for [30, 7, 1]', () => {
    expect(dueThresholds({ notAfter: daysOut(1), createdAt: LONG_AGO }, NOW)).toEqual([30, 7, 1])
  })

  it('an already-expired long-lived cert is due for all four', () => {
    expect(dueThresholds({ notAfter: daysOut(-1), createdAt: LONG_AGO }, NOW)).toEqual([30, 7, 1, 0])
  })

  it('a long-lived cert at 31 days out is due for NOTHING (must-not-fire)', () => {
    expect(dueThresholds({ notAfter: daysOut(31), createdAt: LONG_AGO }, NOW)).toEqual([])
  })

  it('a cert created with 5 days left is due for NOTHING yet (its eligible thresholds, 1 and 0, have not been crossed)', () => {
    expect(dueThresholds({ notAfter: daysOut(5), createdAt: NOW }, NOW)).toEqual([])
  })

  it('that cert, once it reaches 1 day out, is due for [1] only — never [30, 7]', () => {
    const cert = { notAfter: daysOut(5), createdAt: NOW }
    expect(dueThresholds(cert, daysOut(4))).toEqual([1])
  })

  it('that cert, once expired, is due for [1, 0] only — 30 and 7 never fire for it', () => {
    const cert = { notAfter: daysOut(5), createdAt: NOW }
    expect(dueThresholds(cert, daysOut(6))).toEqual([1, 0])
  })
})
