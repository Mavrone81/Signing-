// Server-only module: each organization's signing identity (its active
// SigningCertificate). Short-TTL cached PER ORG, invalidated on save, secrets
// AES-256-GCM encrypted (DATA_KEY) and NEVER returned to a client. Every entry
// point takes the org explicitly — there is no deployment-wide certificate and
// no fallback to another org's. NEVER import into a client bundle.
import { prisma } from '@/lib/db'
import { encrypt, decrypt } from '@/lib/crypto'
import { getObject } from '@/lib/storage'
import { padesSign, type SigningMaterial } from '@/server/pdf/pades'

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
 */
export async function getActiveSigningMaterial(orgId: string): Promise<SigningMaterial | null> {
  const row = await readActiveRow(orgId)
  if (!row) return null
  // The blob store already decrypts on read.
  const p12 = await getObject(row.p12Key)
  return {
    p12,
    passphrase: decryptSecret(row.passphraseEnc),
    tsaUrl: row.tsaUrl,
  }
}

/**
 * The "activate when configured / else unchanged" seal step. Seals with the
 * DOCUMENT's org's active certificate; if that org has none, returns the SAME
 * bytes unchanged (byte-identical to the flatten-only path). `orgId` is
 * required so no finalize path can seal without naming its tenant.
 *
 * Best-effort: if a cert is configured but sealing fails for ANY reason (a
 * dangling/broken config — missing P12 blob, wrong passphrase, forge error),
 * the failure is logged and the UNCHANGED bytes are returned. Document
 * completion is the critical operation; a broken seal config must never trap a
 * fully-signed document in a non-completable state. (The optional RFC-3161
 * timestamp is separately best-effort inside padesSign.)
 */
export async function maybePadesSign(pdfBytes: Uint8Array, orgId: string): Promise<Uint8Array> {
  let material: SigningMaterial | null
  try {
    material = await getActiveSigningMaterial(orgId)
  } catch (err) {
    console.error('[signing] could not load signing material, finalizing without a seal:', err instanceof Error ? err.message : String(err))
    return pdfBytes
  }
  if (!material) return pdfBytes
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
    expired: row.notAfter.getTime() < Date.now(),
  }
}
