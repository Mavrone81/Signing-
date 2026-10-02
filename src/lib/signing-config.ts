// Server-only module: each organization's signing identity (its active
// SigningCertificate). Short-TTL cached PER ORG, invalidated on save, secrets
// AES-256-GCM encrypted (DATA_KEY) and NEVER returned to a client. Every entry
// point takes the org explicitly — there is no deployment-wide certificate and
// no fallback to another org's. NEVER import into a client bundle.
import { prisma } from '@/lib/db'
import { env } from '@/env'
import { encrypt, decrypt } from '@/lib/crypto'
import { getObject } from '@/lib/storage'
import { isCertificateExpired, isCertificateNotYetValid } from '@/lib/pki'
import { padesSign, type SigningMaterial } from '@/server/pdf/pades'

// Default threshold (F1b) for the settings-page "expires in N days"
// indicator — a product default, not derived from anything. See
// getSigningConfigForClient's daysUntilExpiry and the settings page banner.
export const EXPIRY_WARNING_DAYS = 30

// Typed on purpose (F1b review): maybePadesSign's catch block has to
// re-throw these PAST its own best-effort "log and return the unsealed
// bytes" handler for the seal-time refusal to be real rather than nominal.
// If that re-throw matched on an error MESSAGE, rewording it later
// (friendlier text, an org id, a prefix) would silently stop the re-throw
// and reopen the hole with no error anywhere — the catch would just swallow
// it again. An `instanceof` check on a named class can't be broken by a
// wording change, so the message text is free to change and the behavior is
// not. A single base class means a FUTURE sibling (F1c's
// SigningCertNotYetValidError is the first one) is covered by the same
// `instanceof SigningCertUnusableError` check without that check needing to
// be remembered and updated at the one place that matters.
export abstract class SigningCertUnusableError extends Error {
  constructor(message: string, readonly orgId: string) {
    super(message)
  }
}

export class SigningCertExpiredError extends SigningCertUnusableError {
  constructor(orgId: string) {
    super('SIGNING_CERT_EXPIRED', orgId)
    this.name = 'SigningCertExpiredError'
  }
}

// F1c (found reviewing F1b): the mirror image of expiry.
export class SigningCertNotYetValidError extends SigningCertUnusableError {
  constructor(orgId: string) {
    super('SIGNING_CERT_NOT_YET_VALID', orgId)
    this.name = 'SigningCertNotYetValidError'
  }
}

// --- Passphrase encryption (base64 string wire form over the Buffer crypto) ---

export function encryptSecret(plain: string): string {
  return encrypt(Buffer.from(plain, 'utf8')).toString('base64')
}
export function decryptSecret(enc: string): string {
  return decrypt(Buffer.from(enc, 'base64')).toString('utf8')
}

// --- Cached read of the active signing row (metadata + secret refs) ---

type SigningRow = {
  id: string
  p12Key: string
  passphraseEnc: string
  subject: string
  issuer: string
  serial: string | null
  notBefore: Date
  notAfter: Date
  fingerprint: string
  tsaUrl: string | null
  origin: string
  createdAt: Date
}

const CACHE_TTL_MS = 30_000
// Keyed by org: one shared entry would let org A's certificate seal org B's
// documents until it expired.
const cache = new Map<string, { at: number; row: SigningRow | null }>()

async function readActiveRow(orgId: string): Promise<SigningRow | null> {
  const now = Date.now()
  const hit = cache.get(orgId)
  if (hit && now - hit.at < CACHE_TTL_MS) return hit.row
  const row = await prisma.signingCertificate.findFirst({
    where: { orgId, active: true },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      p12Key: true,
      passphraseEnc: true,
      subject: true,
      issuer: true,
      serial: true,
      notBefore: true,
      notAfter: true,
      fingerprint: true,
      tsaUrl: true,
      origin: true,
      createdAt: true,
    },
  })
  cache.set(orgId, { at: now, row })
  return row
}

// Call after any write so the change is live on the next finalize/settings read.
// With an org, drops only that org's entry; with none, drops every entry.
export function invalidateSigningCache(orgId?: string): void {
  if (orgId) cache.delete(orgId)
  else cache.clear()
}

// Whether the org has an active certificate. Reads through the cache.
export async function isSigningConfigured(orgId: string): Promise<boolean> {
  return (await readActiveRow(orgId)) != null
}

/**
 * Decrypted, ready-to-sign material for the org's active cert, or null when it
 * has none. SERVER-ONLY — returns the P12 bytes + passphrase; used exclusively
 * by the finalize pipeline (maybePadesSign).
 *
 * Throws SigningCertExpiredError when the active cert's `notAfter` has
 * passed, or SigningCertNotYetValidError when `notBefore` is still in the
 * future (F1c) — both UNCONDITIONALLY, not gated by any flag (see
 * maybePadesSign for why: this is a different, more urgent hazard than "no
 * certificate at all").
 */
export async function getActiveSigningMaterial(orgId: string): Promise<SigningMaterial | null> {
  const row = await readActiveRow(orgId)
  if (!row) return null
  if (isCertificateExpired(row.notAfter)) throw new SigningCertExpiredError(orgId)
  if (isCertificateNotYetValid(row.notBefore)) throw new SigningCertNotYetValidError(orgId)
  // The blob store already decrypts on read.
  const p12 = await getObject(row.p12Key)
  return {
    p12,
    passphrase: decryptSecret(row.passphraseEnc),
    tsaUrl: row.tsaUrl,
  }
}

/**
 * Seals with the DOCUMENT's org's active certificate. `orgId` is required so
 * no finalize path can seal without naming its tenant.
 *
 * Behavior when the org has NO active certificate depends on
 * `env.SIGNING_FAIL_CLOSED` (default OFF):
 *  - OFF (default): "activate when configured / else unchanged" — returns the
 *    SAME bytes unchanged (byte-identical to the flatten-only path). This was
 *    a deliberate product decision ("Document completion is the critical
 *    operation; a broken seal config must never trap a fully-signed document
 *    in a non-completable state") and remains the shipped default because, as
 *    of this change, the live deployment has zero certificate rows for either
 *    organization — flipping this on unconditionally would stop every
 *    document completion at the next user action.
 *  - ON: THROWS Error('SIGNING_NOT_CONFIGURED') instead. An org with no
 *    certificate is fail-closed for sealing: silently completing a document
 *    the caller believes is sealed, when it is not, is worse than refusing.
 *    Turn this on only after every organization's admin has generated or
 *    uploaded its own certificate in Settings -> Signing.
 *
 * An EXPIRED or NOT-YET-VALID active certificate is a SEPARATE, UNCONDITIONAL
 * case (F1b / F1c): it THROWS a SigningCertUnusableError subclass regardless
 * of SIGNING_FAIL_CLOSED. Unlike "no certificate at all" — which the current
 * deployment's zero-cert state makes safe to leave off for now — a cert in
 * this state looks configured. Letting it seal (or silently pass through
 * unsealed) would produce a signature a verifier may reject while the org
 * believes its documents are sealed; that is never acceptable, flag or no
 * flag.
 *
 * 🔑 The re-throw below is an `instanceof` check, not a message comparison,
 * ON PURPOSE: this catch's job for every OTHER error is to log and fall back
 * to the unsealed bytes, which is exactly the behavior F1b/F1c exist to
 * defeat for a cert in this state. A string match here would be one wording
 * change away from silently falling back into that same best-effort path
 * with no error anywhere. Matching the BASE class means a future sibling
 * guard is covered automatically, without this line needing to be
 * remembered and updated.
 *
 * Either way: if a cert IS configured and currently valid, but sealing fails
 * for ANY OTHER reason (a dangling/broken config — missing P12 blob, wrong
 * passphrase, forge error), the failure is logged and the UNCHANGED bytes are
 * returned — that best-effort fallback is unrelated to this flag and
 * unchanged by it. (The optional RFC-3161 timestamp is separately
 * best-effort inside padesSign.)
 */
export async function maybePadesSign(pdfBytes: Uint8Array, orgId: string): Promise<Uint8Array> {
  let material: SigningMaterial | null
  try {
    material = await getActiveSigningMaterial(orgId)
  } catch (err) {
    if (err instanceof SigningCertUnusableError) throw err
    console.error('[signing] could not load signing material, finalizing without a seal:', err instanceof Error ? err.message : String(err))
    return pdfBytes
  }
  if (!material) {
    if (env.SIGNING_FAIL_CLOSED) throw new Error('SIGNING_NOT_CONFIGURED')
    return pdfBytes
  }
  try {
    return await padesSign(pdfBytes, material)
  } catch (err) {
    console.error('[signing] PAdES sealing failed, finalizing without a seal:', err instanceof Error ? err.message : String(err))
    return pdfBytes
  }
}

// --- Settings-page view: NON-SECRET metadata only (never the P12/passphrase) ---

export type SigningConfigClientView = {
  configured: boolean
  subject: string
  issuer: string
  serial: string | null
  notBefore: string | null
  notAfter: string | null
  fingerprint: string
  tsaUrl: string
  origin: string
  expired: boolean
  // Negative once expired. This is a PASSIVE value shown on a page an admin
  // has to visit — it is NOT a warning mechanism by itself (F1b open item:
  // a real warning needs a PUSH — email, in-app banner, alarm — and which of
  // those is a product decision, not made here). Do not read "the expiry
  // indicator was added" as "the availability cliff is handled".
  daysUntilExpiry: number
} | null

export async function getSigningConfigForClient(orgId: string): Promise<SigningConfigClientView> {
  const row = await prisma.signingCertificate.findFirst({
    where: { orgId, active: true },
    orderBy: { createdAt: 'desc' },
  })
  if (!row) return { configured: false } as unknown as SigningConfigClientView
  return {
    configured: true,
    subject: row.subject,
    issuer: row.issuer,
    serial: row.serial,
    notBefore: row.notBefore.toISOString(),
    notAfter: row.notAfter.toISOString(),
    fingerprint: row.fingerprint,
    tsaUrl: row.tsaUrl ?? '',
    origin: row.origin,
    expired: isCertificateExpired(row.notAfter),
    daysUntilExpiry: Math.ceil((row.notAfter.getTime() - Date.now()) / 86_400_000),
  }
}
