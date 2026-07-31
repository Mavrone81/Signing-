'use server'

import { randomBytes } from 'crypto'
import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { auth } from '@/auth'
import { prisma } from '@/lib/db'
import { uid } from '@/lib/uid'
import { isPlatformAdmin } from '@/lib/auth-providers'
import { putObject, deleteObject } from '@/lib/storage'
import { encryptSecret, invalidateSigningCache } from '@/lib/signing-config'
import { generateSelfSignedP12, parseP12Metadata, type CertMetadata } from '@/lib/pki'

// A P12 upload larger than this is rejected outright (a real signing P12 is a
// few KB; this only guards against accidental/huge uploads).
const MAX_P12_BYTES = 512 * 1024

// Persist a freshly-built platform signing identity: encrypt-store the P12 blob
// + passphrase, deactivate any previous cert, and create the new active row.
// Shared by the self-signed + upload paths. Secrets NEVER touch a log.
async function persistSigningCertificate(opts: {
  p12: Buffer
  passphrase: string
  metadata: CertMetadata
  origin: 'self-signed' | 'uploaded'
  tsaUrl: string | null
  actorId: string
}): Promise<void> {
  const id = uid()
  const p12Key = `signing/${id}.p12`
  // The blob store encrypts at rest (AES-256-GCM / DATA_KEY).
  await putObject(p12Key, opts.p12)

  await prisma.$transaction([
    // Only one active platform cert at a time.
    prisma.signingCertificate.updateMany({ where: { active: true }, data: { active: false } }),
    prisma.signingCertificate.create({
      data: {
        id,
        active: true,
        p12Key,
        passphraseEnc: encryptSecret(opts.passphrase),
        subject: opts.metadata.subject,
        issuer: opts.metadata.issuer,
        serial: opts.metadata.serial,
        notBefore: opts.metadata.notBefore,
        notAfter: opts.metadata.notAfter,
        fingerprint: opts.metadata.fingerprint,
        tsaUrl: opts.tsaUrl,
        origin: opts.origin,
        createdBy: opts.actorId,
      },
    }),
  ])

  invalidateSigningCache()
  revalidatePath('/settings/signing')
}

function cleanTsa(raw: string): string | null {
  const v = raw.trim()
  if (!v) return null
  if (!/^https?:\/\//i.test(v)) return null
  return v
}

// Generate + activate an RSA-2048 self-signed platform certificate. A random
// passphrase is minted server-side (the admin never needs it — the P12 is only
// ever read by the finalize pipeline). Platform-admin gated.
export async function generatePlatformCertificate(formData: FormData): Promise<void> {
  const session = await auth()
  if (!isPlatformAdmin(session)) redirect('/documents')

  const commonName = String(formData.get('commonName') ?? '').trim() || 'Bevora Sign'
  const yearsRaw = Number.parseInt(String(formData.get('years') ?? ''), 10)
  const years = Number.isFinite(yearsRaw) && yearsRaw >= 1 && yearsRaw <= 30 ? yearsRaw : 3
  const tsaUrl = cleanTsa(String(formData.get('tsaUrl') ?? ''))

  const passphrase = randomBytes(24).toString('hex')
  const { p12, metadata } = generateSelfSignedP12({ commonName, passphrase, years })

  await persistSigningCertificate({
    p12,
    passphrase,
    metadata,
    origin: 'self-signed',
    tsaUrl,
    actorId: session!.user.id,
  })
  redirect('/settings/signing?saved=generated')
}

// Upload + activate an admin-supplied PKCS#12 (.p12/.pfx). The passphrase is
// validated by parsing the P12 (wrong passphrase → parse throws → error param).
// Platform-admin gated.
export async function uploadPlatformCertificate(formData: FormData): Promise<void> {
  const session = await auth()
  if (!isPlatformAdmin(session)) redirect('/documents')

  const file = formData.get('p12')
  const passphrase = String(formData.get('passphrase') ?? '')
  const tsaUrl = cleanTsa(String(formData.get('tsaUrl') ?? ''))

  if (!(file instanceof File) || file.size === 0) redirect('/settings/signing?error=nofile')
  if ((file as File).size > MAX_P12_BYTES) redirect('/settings/signing?error=toolarge')

  const p12 = Buffer.from(await (file as File).arrayBuffer())

  let metadata: CertMetadata
  try {
    metadata = parseP12Metadata(p12, passphrase)
  } catch {
    // Wrong passphrase or an unparseable/incomplete P12.
    redirect('/settings/signing?error=badp12')
  }

  await persistSigningCertificate({
    p12,
    passphrase,
    metadata,
    origin: 'uploaded',
    tsaUrl,
    actorId: session!.user.id,
  })
  redirect('/settings/signing?saved=uploaded')
}

// Update just the RFC-3161 TSA URL on the active cert (leave blank to clear).
export async function saveTsaUrl(formData: FormData): Promise<void> {
  const session = await auth()
  if (!isPlatformAdmin(session)) redirect('/documents')

  const tsaUrl = cleanTsa(String(formData.get('tsaUrl') ?? ''))
  const active = await prisma.signingCertificate.findFirst({
    where: { active: true },
    orderBy: { createdAt: 'desc' },
  })
  if (!active) redirect('/settings/signing?error=notconfigured')
  await prisma.signingCertificate.update({ where: { id: active!.id }, data: { tsaUrl } })

  invalidateSigningCache()
  revalidatePath('/settings/signing')
  redirect('/settings/signing?saved=tsa')
}

// Deactivate + remove the active platform cert (and its encrypted blob).
// Finalize reverts to the flatten-only path — no seal. Platform-admin gated.
export async function removePlatformCertificate(): Promise<void> {
  const session = await auth()
  if (!isPlatformAdmin(session)) redirect('/documents')

  const active = await prisma.signingCertificate.findFirst({
    where: { active: true },
    orderBy: { createdAt: 'desc' },
  })
  if (active) {
    await deleteObject(active.p12Key)
    await prisma.signingCertificate.delete({ where: { id: active.id } })
  }
  invalidateSigningCache()
  revalidatePath('/settings/signing')
  redirect('/settings/signing?saved=removed')
}
