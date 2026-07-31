import { randomBytes } from 'crypto'
import { sha256hex } from '@/lib/hash'

// Public-API key material. A key is `sk_live_<random>` where <random> is 32
// URL-safe base64 chars of CSPRNG entropy. The raw key is shown to its creator
// EXACTLY ONCE; only the (non-secret) `prefix` and the SHA-256 `hashedKey` are
// persisted — the raw key is never stored and can never be recovered.

export const API_KEY_LIVE_PREFIX = 'sk_live_'
// How many leading characters of the raw key we keep as a human-facing
// identifier (e.g. "sk_live_a1b2"). Non-secret: it can't be used to authenticate.
const PREFIX_LEN = 12

export interface GeneratedApiKey {
  // The full raw key — return to the caller ONCE, never persist.
  raw: string
  // First ~8-12 chars, safe to store + display so a key is identifiable.
  prefix: string
  // SHA-256 hex of the full raw key — what we persist + look up on auth.
  hashedKey: string
}

/**
 * Mints a fresh API key. `raw` is `sk_live_<32 base64url chars>`; `prefix` is
 * its first PREFIX_LEN chars; `hashedKey` is sha256(raw). The raw key is only
 * ever available here (creation time) — callers must surface it once and drop it.
 */
export function generateApiKey(): GeneratedApiKey {
  // 24 random bytes → 32 base64url chars (no padding), ~192 bits of entropy.
  const secret = randomBytes(24).toString('base64url')
  const raw = `${API_KEY_LIVE_PREFIX}${secret}`
  return {
    raw,
    prefix: raw.slice(0, PREFIX_LEN),
    hashedKey: hashApiKey(raw),
  }
}

// Deterministic SHA-256 of a raw key. Authentication hashes the presented token
// and compares against the stored `hashedKey` via a unique-index lookup — the
// comparison is over fixed-length digests (never the raw secret), so it does not
// leak length/content through timing.
export function hashApiKey(raw: string): string {
  return sha256hex(Buffer.from(raw, 'utf8'))
}

// Cheap shape check before hashing/DB work: our keys always carry the live
// prefix. Rejects obviously-wrong tokens (empty / wrong scheme) early.
export function looksLikeApiKey(raw: string): boolean {
  return typeof raw === 'string' && raw.startsWith(API_KEY_LIVE_PREFIX) && raw.length > API_KEY_LIVE_PREFIX.length + 8
}
