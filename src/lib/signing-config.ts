// Server-only module: the deployment-wide PLATFORM signing identity (the active
// SigningCertificate singleton). Mirrors src/lib/email-config.ts — short-TTL
// cached, invalidated on save, secrets AES-256-GCM encrypted (DATA_KEY) and
// NEVER returned to a client. NEVER import into a client bundle.
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
let cache: { at: number; row: SigningRow | null } | null = null

async function readActiveRow(): Promise<SigningRow | null> {
  const now = Date.now()
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.row
  const row = await prisma.signingCertificate.findFirst({
    where: { active: true },
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
  cache = { at: now, row }
  return row
}

// Call after any write so the change is live on the next finalize/settings read.
export function invalidateSigningCache(): void {
  cache = null
}

// Whether platform PAdES signing is active + configured. Reads through the cache.
export async function isSigningConfigured(): Promise<boolean> {
  return (await readActiveRow()) != null
}

/**
 * Decrypted, ready-to-sign material for the active platform cert, or null when
 * none is configured. SERVER-ONLY — returns the P12 bytes + passphrase; used
 * exclusively by the finalize pipeline (maybePadesSign).
 */
export async function getActiveSigningMaterial(): Promise<SigningMaterial | null> {
  const row = await readActiveRow()
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
 * The "activate when configured / else unchanged" seal step. If a platform
 * signing cert is active, returns the input bytes PAdES-signed; otherwise
 * returns the SAME bytes unchanged (byte-identical to the flatten-only path).
 *
 * Best-effort: if a cert is configured but sealing fails for ANY reason (a
 * dangling/broken config — missing P12 blob, wrong passphrase, forge error),
 * the failure is logged and the UNCHANGED bytes are returned. Document
 * completion is the critical operation; a broken seal config must never trap a
 * fully-signed document in a non-completable state. (The optional RFC-3161
 * timestamp is separately best-effort inside padesSign.)
 */
export async function maybePadesSign(pdfBytes: Uint8Array): Promise<Uint8Array> {
  let material: SigningMaterial | null
  try {
    material = await getActiveSigningMaterial()
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

export async function getSigningConfigForClient(): Promise<SigningConfigClientView> {
  const row = await prisma.signingCertificate.findFirst({
    where: { active: true },
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
