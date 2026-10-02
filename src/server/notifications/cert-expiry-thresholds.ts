// Pure, DB-free threshold logic for Sign #11 (certificate-expiry warnings).
// Kept separate from the DB-backed reconciliation (cert-expiry.ts) so the
// boundary arithmetic — the part this whole feature IS — can be tested
// densely with an injected `now`, never a global Date mock.
import { EXPIRY_WARNING_DAYS } from '@/lib/signing-config'
import { isCertificateExpired, daysUntilExpiry } from '@/lib/pki'

// Reuses signing-config.ts's EXPIRY_WARNING_DAYS (30) rather than a second
// threshold of its own: a banner and a notification disagreeing on the day
// count would make the whole warning system look broken even where parts of
// it work.
export const THRESHOLD_DAYS = [EXPIRY_WARNING_DAYS, 7, 1, 0] as const
export type ThresholdDays = (typeof THRESHOLD_DAYS)[number]

const DAY_MS = 86_400_000

// The instant threshold T first becomes true for a given notAfter.
function crossingInstant(notAfter: Date, thresholdDays: number): number {
  return notAfter.getTime() - thresholdDays * DAY_MS
}

// A threshold only fires if its crossing instant falls AT OR AFTER the
// certificate became active — otherwise the cert was already inside that
// window the moment it was configured, and retroactively warning about a
// threshold that was never true during this cert's own validity would tell
// whoever just set the date something that was already false when they set
// it. (Documented decision, Sign #11: a cert uploaded with 5 days left never
// fires its 30- or 7-day notices — only 1-day and expiry-day, since those
// crossing instants are still after createdAt. Either direction was
// defensible per spec; this is the one chosen, and it is the reason this
// function exists as its own named decision rather than being inlined.)
export function isThresholdEligible(
  cert: { notAfter: Date; createdAt: Date },
  thresholdDays: number,
): boolean {
  return crossingInstant(cert.notAfter, thresholdDays) >= cert.createdAt.getTime()
}

// Whether threshold T has been crossed as of `now`. Reuses the SAME shared
// functions the sealing check and the settings-page indicator already use —
// never a third independently-computed comparison, which is exactly how a
// disagreement window opens between "sealing refuses" and "nothing told
// anyone." T=0 IS isCertificateExpired (not a reimplementation of its `<=`);
// T>0 compares against daysUntilExpiry, which is mathematically equivalent
// to the same inclusive `<=` boundary for an integer threshold (ceil(x) <= T
// iff x <= T, for integer T) — proved equivalent, not just believed to be.
export function hasThresholdCrossed(notAfter: Date, thresholdDays: number, now: Date): boolean {
  if (thresholdDays === 0) return isCertificateExpired(notAfter, now)
  return daysUntilExpiry(notAfter, now) <= thresholdDays
}

// Every threshold that is both eligible and crossed as of `now`, for a
// certificate with this notAfter/createdAt. Does NOT know about
// already-sent state — that is the reconciliation layer's job (DB-backed,
// for idempotency across restarts); this function is pure and total.
export function dueThresholds(cert: { notAfter: Date; createdAt: Date }, now: Date): ThresholdDays[] {
  return THRESHOLD_DAYS.filter(
    (t) => isThresholdEligible(cert, t) && hasThresholdCrossed(cert.notAfter, t, now),
  )
}
