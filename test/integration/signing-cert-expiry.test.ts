// @vitest-environment node
//
// F1b: an already-expired P12 must be rejected at upload, and an active
// certificate that has aged into expiry must refuse to seal — UNCONDITIONALLY,
// not gated by env.SIGNING_FAIL_CLOSED (that flag is about "no certificate at
// all"; an expired one is a different, more urgent hazard: it looks
// configured and silently produces a signature a verifier may reject). This
// file never sets SIGNING_FAIL_CLOSED, which is the point: it proves the
// expiry guard holds in the DEFAULT (flag-off) state.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
process.env.DATA_KEY ||= '0'.repeat(64)
process.env.STORAGE_DIR = '/tmp/ds-expiry-' + Date.now()

const authMock = vi.hoisted(() => ({ session: null as unknown }))
vi.mock('@/auth', () => ({ auth: () => Promise.resolve(authMock.session) }))
vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw Object.assign(new Error('REDIRECT'), { url })
  },
}))
vi.mock('next/cache', () => ({ revalidatePath: () => {} }))

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { PDFDocument } from 'pdf-lib'
import { prisma } from '../../src/lib/db'
import { generateSelfSignedP12 } from '../../src/lib/pki'
import { maybePadesSign, invalidateSigningCache, SigningCertExpiredError, SigningCertNotYetValidError } from '../../src/lib/signing-config'
import { uploadPlatformCertificate } from '../../src/app/(app)/settings/signing/actions'
import { createDocument, saveFields, saveRecipients, sendForSignature } from '../../src/server/documents/actions'
import { completeSigning } from '../../src/server/documents/signing'

const STORAGE_DIR = process.env.STORAGE_DIR!

let org: string
let owner: string

async function samplePdfBytes(): Promise<Buffer> {
  const d = await PDFDocument.create()
  d.addPage([600, 800])
  return Buffer.from(await d.save())
}

// A REAL, otherwise-normal self-signed P12 (same production code path as
// generatePlatformCertificate) with an arbitrary validity window — same code
// path as a real upload, so the fixture can't pass while the real path is
// broken.
function p12With(validity: { notBefore: Date; notAfter: Date }): { p12: Buffer; passphrase: string } {
  const passphrase = 'expiry-test-pass'
  const { p12 } = generateSelfSignedP12({ commonName: 'Expiry Test Cert', passphrase, validity })
  return { p12, passphrase }
}

// 400 days expired — not a hair's-breadth value, so the assertion can't be
// satisfied by a clock-skew fluke or a boundary that is technically true for
// one second (clock skew is seconds-to-minutes, not months, and a test that
// can pass by accident is worse than a looser one).
function expiredP12() {
  return p12With({
    notBefore: new Date(Date.now() - 500 * 86_400_000),
    notAfter: new Date(Date.now() - 400 * 86_400_000),
  })
}

async function uploadAndGetRedirect(p12: Buffer, passphrase: string): Promise<string | undefined> {
  const fd = new FormData()
  fd.set('p12', new File([new Uint8Array(p12)], 'test.p12'))
  fd.set('passphrase', passphrase)
  return asUser(sessionOf(owner, org), () => uploadPlatformCertificate(fd))
}

// Directory a persisted blob for this org would live under
// (persistSigningCertificate: `signing/${orgId}/${id}.p12`) — checked
// directly on disk, not through getObject(), since a rejected upload never
// learns the id a real persist would have minted.
async function orgBlobCount(): Promise<number> {
  try {
    return (await fs.readdir(path.join(STORAGE_DIR, 'signing', org))).length
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0
    throw err
  }
}

async function asUser(session: unknown, action: () => Promise<void>): Promise<string | undefined> {
  authMock.session = session
  try {
    await action()
  } catch (e) {
    return (e as { url?: string }).url
  }
  return undefined
}

beforeAll(async () => {
  const stamp = Date.now()
  org = (await prisma.organization.create({ data: { name: 'Expiry Org', slug: 'exp-' + stamp } })).id
  owner = (await prisma.user.create({ data: { email: `exp-owner-${stamp}@x.com`, name: 'owner', passwordHash: 'x', role: 'user' } })).id
  await prisma.membership.create({ data: { orgId: org, userId: owner, role: 'owner' } })
})

afterAll(async () => {
  await prisma.signingCertificate.deleteMany({ where: { orgId: org } })
  await prisma.user.deleteMany({ where: { id: owner } })
  await prisma.organization.deleteMany({ where: { id: org } })
})

async function clearCerts() {
  await prisma.signingCertificate.deleteMany({ where: { orgId: org } })
  invalidateSigningCache()
}

const sessionOf = (id: string, orgId: string) => ({
  user: { id, orgId, orgRole: 'owner' as const, isPlatformAdmin: false },
})

async function createExpiredActiveCert(notAfter: Date, notBefore = new Date(Date.now() - 500 * 86_400_000)) {
  await prisma.signingCertificate.create({
    data: {
      id: 'expiry-test-active-' + Date.now() + '-' + Math.random().toString(36).slice(2),
      orgId: org,
      active: true,
      p12Key: 'signing/does-not-matter-never-read.p12',
      passphraseEnc: 'unused',
      subject: 'CN=Expiry Test Active',
      issuer: 'CN=Expiry Test Active',
      notBefore,
      notAfter,
      fingerprint: 'e'.repeat(64),
      origin: 'uploaded',
    },
  })
}

describe('F1b: upload rejects an already-expired P12', () => {
  it('redirects with error=expired and persists NOTHING — no blob, no row, no active cert for the org', async () => {
    await clearCerts()
    const { p12, passphrase } = expiredP12()

    const to = await uploadAndGetRedirect(p12, passphrase)

    expect(to).toBe('/settings/signing?error=expired')
    // Not just "redirected" — actually nothing was written: no row, and no
    // blob either, so a future reordering of the redirect vs.
    // persistSigningCertificate can't silently leave an orphaned P12 on
    // disk while this assertion stays green.
    expect(await prisma.signingCertificate.count({ where: { orgId: org } })).toBe(0)
    expect(await orgBlobCount()).toBe(0)
  })
})

describe('F1b: sealing refuses an EXPIRED active certificate, regardless of SIGNING_FAIL_CLOSED', () => {
  it('maybePadesSign throws SigningCertExpiredError (through the best-effort catch, not swallowed by it)', async () => {
    await clearCerts()
    // The one legitimate way this row exists: a certificate that was valid
    // when configured has since aged past its notAfter. Built directly (not
    // via the upload path) because the guard must hold for THIS case too —
    // a cert can expire long after it was validly accepted.
    await createExpiredActiveCert(new Date(Date.now() - 400 * 86_400_000))

    const bytes = await samplePdfBytes()
    // Asserting the TYPE, not just the message text: this is
    // exactly the distinction that matters, because maybePadesSign's catch
    // block exists to swallow errors and fall back to unsealed bytes — a
    // message-only assertion would stay green even if a future edit changed
    // the re-throw in signing-config.ts back to a string comparison that a
    // later wording change could silently defeat.
    await expect(maybePadesSign(bytes, org)).rejects.toBeInstanceOf(SigningCertExpiredError)
  })

  it('end-to-end: the last recipient signing does NOT complete the document when its cert has expired — the signature is kept, the document stays `sent`', async () => {
    await clearCerts()
    await createExpiredActiveCert(new Date(Date.now() - 400 * 86_400_000))

    const { id } = await createDocument(owner, org, 'expired-seal.pdf', await samplePdfBytes())
    const [rec] = await saveRecipients(id, [{ name: 'Signer', email: `exp-s${Date.now()}@x.com` }])
    await saveFields(id, [
      { page: 1, type: 'signature', x: 0.1, y: 0.1, w: 0.2, h: 0.08, value: '', recipientId: rec.id },
    ])
    const [link] = await sendForSignature(id, owner)
    const field = await prisma.field.findFirst({ where: { recipientId: rec.id } })
    const res = await completeSigning(link.token, [{ fieldId: field!.id, value: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC' }])

    if (!res.ok) throw new Error(`expected ok, got reason: ${res.reason}`)
    expect(res.completed).toBe(false)

    const doc = await prisma.document.findUnique({ where: { id } })
    expect(doc?.status).toBe('sent')
    expect(doc?.signedKey).toBeNull()
    const recipientAfter = await prisma.recipient.findUnique({ where: { id: rec.id } })
    expect(recipientAfter?.status).toBe('signed')

    await prisma.document.delete({ where: { id } })
  })
})

describe('F1b: the notAfter boundary', () => {
  it('a certificate expiring one second in the future is NOT yet expired', async () => {
    await clearCerts()
    await createExpiredActiveCert(new Date(Date.now() + 1000))

    const bytes = await samplePdfBytes()
    // Not-expired: must not throw SigningCertExpiredError. (It still can't
    // actually seal — p12Key points nowhere real — so it falls through the
    // UNRELATED best-effort catch and returns the bytes unchanged; the
    // assertion here is specifically the ABSENCE of the expiry throw.)
    await expect(maybePadesSign(bytes, org)).resolves.toEqual(bytes)
  })

  it('a certificate that expired one second ago IS expired', async () => {
    await clearCerts()
    await createExpiredActiveCert(new Date(Date.now() - 1000))

    const bytes = await samplePdfBytes()
    await expect(maybePadesSign(bytes, org)).rejects.toBeInstanceOf(SigningCertExpiredError)
  })
})

// F1c (found while reviewing the notAfter fix, by construction): notBefore
// was never checked anywhere — the mirror image of the notAfter case. A
// not-yet-valid P12 uploaded cleanly and became the org's active
// certificate (measured). What it would then do at seal time was NOT
// established; both call sites are gated pre-emptively regardless, so the
// question does not arise.
describe('F1c: upload rejects a NOT-YET-VALID P12 (notBefore in the future)', () => {
  it('redirects with error=notyetvalid and persists nothing', async () => {
    await clearCerts()
    const { p12, passphrase } = p12With({
      notBefore: new Date(Date.now() + 100 * 86_400_000),
      notAfter: new Date(Date.now() + 500 * 86_400_000),
    })

    const to = await uploadAndGetRedirect(p12, passphrase)

    expect(to).toBe('/settings/signing?error=notyetvalid')
    expect(await prisma.signingCertificate.count({ where: { orgId: org } })).toBe(0)
    expect(await orgBlobCount()).toBe(0)
  })
})

describe('F1c: sealing refuses a NOT-YET-VALID active certificate', () => {
  it('maybePadesSign throws SigningCertNotYetValidError, through the same best-effort catch', async () => {
    await clearCerts()
    await createExpiredActiveCert(
      /* notAfter */ new Date(Date.now() + 500 * 86_400_000),
      /* notBefore */ new Date(Date.now() + 100 * 86_400_000),
    )

    const bytes = await samplePdfBytes()
    await expect(maybePadesSign(bytes, org)).rejects.toBeInstanceOf(SigningCertNotYetValidError)
  })
})
