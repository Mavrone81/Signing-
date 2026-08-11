/**
 * Login throttle: 5 FAILED attempts per (email, IP) per 15 minutes.
 *
 * Keyed on the pair, deliberately. Per-IP alone misses credential stuffing that
 * rotates addresses while walking a list of accounts. Per-email alone hands
 * anyone a denial-of-service against a known account -- fail five times and the
 * real signer is locked out, no password required. The pair stops distributed
 * stuffing from grinding one account while confining any lockout to the
 * attacker's own address.
 *
 * Counts failures only and clears on success, so someone who mistypes once and
 * then gets it right is never penalised. The window self-clears, so nothing here
 * can leave a signer locked out waiting on an admin.
 *
 * State is in this process's memory. Correct while the app is a single
 * container, which it is. Running more than one instance would divide the count
 * across them and quietly raise the real limit -- that would need a shared
 * store, not more instances.
 */

const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILS = 5;

type Entry = { n: number; resetAt: number };
const fails = new Map<string, Entry>();

/**
 * The caller's address.
 *
 * Deliberately NOT the first `X-Forwarded-For` entry. Nginx builds that header
 * with `$proxy_add_x_forwarded_for`, which APPENDS the real peer to whatever the
 * client already sent, so the first entry is attacker-supplied and a throttle
 * keyed on it can be walked straight through with a fresh fake address per
 * request. `X-Real-IP` is set by nginx with `proxy_set_header`, which REPLACES
 * any client value; the last `X-Forwarded-For` entry is the fallback, being the
 * one the trusted proxy appended.
 *
 * The app port is published on loopback only, so nginx is the sole path in and
 * neither header can be set by an outside caller.
 */
export function clientIp(headers: { get(name: string): string | null }): string {
  const realIp = headers.get('x-real-ip');
  if (realIp && realIp.trim()) return realIp.trim();

  const xff = headers.get('x-forwarded-for');
  if (xff) {
    const parts = xff.split(',').map((p) => p.trim()).filter(Boolean);
    if (parts.length) return parts[parts.length - 1];
  }
  return 'unknown';
}

export function loginKey(email: string, ip: string): string {
  return `${email.trim().toLowerCase().slice(0, 190)}|${ip}`;
}

export function isBlocked(key: string, now: number = Date.now()): boolean {
  const e = fails.get(key);
  return !!e && now <= e.resetAt && e.n >= MAX_FAILS;
}

export function recordFailure(key: string, now: number = Date.now()): void {
  const e = fails.get(key);
  if (!e || now > e.resetAt) fails.set(key, { n: 1, resetAt: now + WINDOW_MS });
  else e.n += 1;
}

export function clearFailures(key: string): void {
  fails.delete(key);
}

/** Drop expired entries so the map cannot grow without bound. */
export function sweep(now: number = Date.now()): void {
  for (const [k, e] of fails) if (now > e.resetAt) fails.delete(k);
}

/** Test seam: reset all state between cases. */
export function __resetForTests(): void {
  fails.clear();
}

export const LOGIN_WINDOW_MS = WINDOW_MS;
export const LOGIN_MAX_FAILS = MAX_FAILS;
