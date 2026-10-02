'use server'

import { randomBytes } from 'crypto'
import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { auth } from '@/auth'
import { prisma } from '@/lib/db'
import { uid } from '@/lib/uid'
import { canManageOrgSettings } from '@/lib/org-settings'
import { putObject, deleteObject } from '@/lib/storage'
import { encryptSecret, invalidateSigningCache } from '@/lib/signing-config'
import { generateSelfSignedP12, parseP12Metadata, isCertificateExpired, isCertificateNotYetValid, type CertMetadata } from '@/lib/pki'

// A P12 upload larger than this is rejected outright (a real signing P12 is a
// few KB; this only guards against accidental/huge uploads).
const MAX_P12_BYTES = 512 * 1024

// Every action re-checks the org-settings gate itself (never trusting that the
// page gated it) and takes the org from the SESSION, never from the form, so one
// org's admin cannot write another org's certificate by editing a field.
async function requireOrgManager(): Promise<{ orgId: string; userId: string }> {
  const session = await auth()
  const user = session?.user
  if (!canManageOrgSettings(user)) redirect('/documents')
  return { orgId: user.orgId, userId: session!.user.id }
}

// Persist a freshly-built signing identity for ONE org: encrypt-store the P12
// blob + passphrase, deactivate that org's previous cert, and create the new
// active row. Shared by the self-signed + upload paths. Secrets NEVER touch a log.
async function persistSigningCertificate(opts: {
  orgId: string
  p12: Buffer
  passphrase: string
  metadata: CertMetadata
  origin: 'self-signed' | 'uploaded'
  tsaUrl: string | null
  actorId: string
}): Promise<void> {
  const id = uid()
  const p12Key = `signing/${opts.orgId}/${id}.p12`
  // The blob store encrypts at rest (AES-256-GCM / DATA_KEY).
  await putObject(p12Key, opts.p12)

  await prisma.$transaction([
    // One active cert per org. The org filter is essential: without it, saving
    // a cert here would silently deactivate every other org's.
    prisma.signingCertificate.updateMany({
      where: { orgId: opts.orgId, active: true },
      data: { active: false },
    }),
    prisma.signingCertificate.create({
      data: {
        id,
        orgId: opts.orgId,
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

  invalidateSigningCache(opts.orgId)
  revalidatePath('/settings/signing')
}

function cleanTsa(raw: string): string | null {
  const v = raw.trim()
  if (!v) return null
  if (!/^https?:\/\//i.test(v)) return null
  return v
}

function activeCertOf(orgId: string) {
  return prisma.signingCertificate.findFirst({
    where: { orgId, active: true },
    orderBy: { createdAt: 'desc' },
  })
}

// Generate + activate an RSA-2048 self-signed certificate for the caller's org.
// A random passphrase is minted server-side (nobody needs it — the P12 is only
// ever read by the finalize pipeline).
export async function generatePlatformCertificate(formData: FormData): Promise<void> {
  const { orgId, userId } = await requireOrgManager()

  const commonName = String(formData.get('commonName') ?? '').trim() || 'Bevora Sign'
  const yearsRaw = Number.parseInt(String(formData.get('years') ?? ''), 10)
  const years = Number.isFinite(yearsRaw) && yearsRaw >= 1 && yearsRaw <= 30 ? yearsRaw : 3
  const tsaUrl = cleanTsa(String(formData.get('tsaUrl') ?? ''))

  const passphrase = randomBytes(24).toString('hex')
  const { p12, metadata } = generateSelfSignedP12({ commonName, passphrase, years })

  await persistSigningCertificate({
    orgId,
    p12,
    passphrase,
    metadata,
    origin: 'self-signed',
    tsaUrl,
    actorId: userId,
  })
  redirect('/settings/signing?saved=generated')
}

// Upload + activate an admin-supplied PKCS#12 (.p12/.pfx) for the caller's org.
// The passphrase is validated by parsing the P12 (wrong passphrase → parse
// throws → error param).
export async function uploadPlatformCertificate(formData: FormData): Promise<void> {
  const { orgId, userId } = await requireOrgManager()

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

  // F1b: reject an already-expired certificate rather than persisting it.
  // This alone is not enough — a certificate valid today can still expire
  // LATER, which is the normal case — so the sealing path (signing-config.ts
  // maybePadesSign) enforces the same check unconditionally at seal time too.
  if (isCertificateExpired(metadata.notAfter)) redirect('/settings/signing?error=expired')
  // F1c (found reviewing F1b): the mirror image — reject a
  // not-yet-valid certificate too. Same reasoning, same seal-time backstop.
  if (isCertificateNotYetValid(metadata.notBefore)) redirect('/settings/signing?error=notyetvalid')

  await persistSigningCertificate({
    orgId,
    p12,
    passphrase,
    metadata,
    origin: 'uploaded',
    tsaUrl,
    actorId: userId,
  })
  redirect('/settings/signing?saved=uploaded')
}

// Update just the RFC-3161 TSA URL on the org's active cert (blank clears it).
export async function saveTsaUrl(formData: FormData): Promise<void> {
  const { orgId } = await requireOrgManager()

  const tsaUrl = cleanTsa(String(formData.get('tsaUrl') ?? ''))
  const active = await activeCertOf(orgId)
  if (!active) redirect('/settings/signing?error=notconfigured')
  await prisma.signingCertificate.update({ where: { id: active!.id }, data: { tsaUrl } })

  invalidateSigningCache(orgId)
  revalidatePath('/settings/signing')
  redirect('/settings/signing?saved=tsa')
}

// Deactivate + remove the org's active cert (and its encrypted blob). The org's
// finalize reverts to the flatten-only path — no seal.
export async function removePlatformCertificate(): Promise<void> {
  const { orgId } = await requireOrgManager()

  const active = await activeCertOf(orgId)
  if (active) {
    await deleteObject(active.p12Key)
    await prisma.signingCertificate.delete({ where: { id: active.id } })
  }
  invalidateSigningCache(orgId)
  revalidatePath('/settings/signing')
  redirect('/settings/signing?saved=removed')
}
