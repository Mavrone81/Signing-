// @vitest-environment node
//
// PAdES/PKI end-to-end with PER-ORG certificates: the "activate when configured
// / else unchanged" guarantee, the full send→sign→finalize seal with the
// document's own org's cert, no cross-tenant sealing, the org-settings gate on
// the Settings → Signing actions, and the no-secrets settings view. Real
// Postgres + filesystem + pdf-lib, like the other integration tests.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
process.env.DATA_KEY ||= '0'.repeat(64)
process.env.STORAGE_DIR = '/tmp/ds-pades-' + Date.now()

// Mutable mock session for the org-settings gate on the settings actions.
const authMock = vi.hoisted(() => ({ session: null as unknown }))
vi.mock('@/auth', () => ({ auth: () => Promise.resolve(authMock.session) }))
// The settings actions redirect() on success/failure and revalidatePath() — make
// redirect throw a catchable sentinel carrying its target; revalidatePath a noop.
vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw Object.assign(new Error('REDIRECT'), { url })
  },
}))
vi.mock('next/cache', () => ({ revalidatePath: () => {} }))

import { PDFDocument } from 'pdf-lib'
import {
  createDocument,
  saveFields,
  saveRecipients,
  sendForSignature,
} from '../../src/server/documents/actions'
import { completeSigning } from '../../src/server/documents/signing'
import { prisma } from '../../src/lib/db'
import { getObject } from '../../src/lib/storage'
import { verifyPades } from '../../src/server/pdf/pades'
import {
  maybePadesSign,
  getSigningConfigForClient,
  invalidateSigningCache,
} from '../../src/lib/signing-config'
import {
  generatePlatformCertificate,
  removePlatformCertificate,
} from '../../src/app/(app)/settings/signing/actions'

let orgA: string
let orgB: string
let ownerA: string
let memberA: string
let ownerB: string
const documentIds: string[] = []

const PNG_1x1 =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC'

async function samplePdfBytes(): Promise<Buffer> {
  const d = await PDFDocument.create()
  d.addPage([600, 800])
  return Buffer.from(await d.save())
}

async function makeSentAndComplete(userId: string, orgId: string): Promise<string> {
  const { id } = await createDocument(userId, orgId, 'pades.pdf', await samplePdfBytes())
  documentIds.push(id)
  const [rec] = await saveRecipients(id, [{ name: 'Signer', email: `s${Date.now()}@x.com` }])
  await saveFields(id, [
    { page: 1, type: 'signature', x: 0.1, y: 0.1, w: 0.2, h: 0.08, value: '', recipientId: rec.id },
  ])
  const [link] = await sendForSignature(id, userId)
  const field = await prisma.field.findFirst({ where: { recipientId: rec.id } })
  const res = await completeSigning(link.token, [{ fieldId: field!.id, value: PNG_1x1 }])
  expect(res.ok).toBe(true)
  return id
}

async function signedBytesOf(id: string): Promise<Buffer> {
  const doc = await prisma.document.findUnique({ where: { id } })
  expect(doc?.status).toBe('completed')
  return getObject(doc!.signedKey!)
}

// Run a settings action as `session`, swallowing its redirect sentinel and
// returning where it redirected to.
async function asUser(session: unknown, action: () => Promise<void>): Promise<string | undefined> {
  authMock.session = session
  try {
    await action()
  } catch (e) {
    return (e as { url?: string }).url
  }
  return undefined
}

function generateForm(cn: string): FormData {
  const fd = new FormData()
  fd.set('commonName', cn)
  fd.set('years', '3')
  return fd
}

async function clearCerts() {
  await prisma.signingCertificate.deleteMany({ where: { orgId: { in: [orgA, orgB] } } })
  invalidateSigningCache()
}

beforeAll(async () => {
  const stamp = Date.now()
  orgA = (await prisma.organization.create({ data: { name: 'PAdES Org A', slug: 'pades-a-' + stamp } })).id
  orgB = (await prisma.organization.create({ data: { name: 'PAdES Org B', slug: 'pades-b-' + stamp } })).id
  const mk = async (tag: string) =>
    (await prisma.user.create({ data: { email: `pades-${tag}-${stamp}@x.com`, name: tag, passwordHash: 'x', role: 'user' } })).id
  ownerA = await mk('owner-a')
  memberA = await mk('member-a')
  ownerB = await mk('owner-b')
  await prisma.membership.createMany({
    data: [
      { orgId: orgA, userId: ownerA, role: 'owner' },
      { orgId: orgA, userId: memberA, role: 'member' },
      { orgId: orgB, userId: ownerB, role: 'owner' },
    ],
  })
})

afterAll(async () => {
  await prisma.signingCertificate.deleteMany({ where: { orgId: { in: [orgA, orgB] } } })
  if (documentIds.length) await prisma.document.deleteMany({ where: { id: { in: documentIds } } })
  await prisma.user.deleteMany({ where: { id: { in: [ownerA, memberA, ownerB] } } })
  await prisma.organization.deleteMany({ where: { id: { in: [orgA, orgB] } } })
})

const sessionOf = (id: string, orgId: string, orgRole: 'owner' | 'admin' | 'member') => ({
  user: { id, orgId, orgRole, isPlatformAdmin: false },
})

describe('activate-when-configured / else unchanged', () => {
  it('maybePadesSign returns the bytes UNCHANGED when the org has no cert', async () => {
    await clearCerts()
    const bytes = await samplePdfBytes()
    const out = await maybePadesSign(bytes, orgA)
    expect(Buffer.from(out).equals(bytes)).toBe(true)
    expect(verifyPades(out).signed).toBe(false)
  })

  it('finalizes a completed document WITHOUT a signature when the org has no cert', async () => {
    await clearCerts()
    const signed = await signedBytesOf(await makeSentAndComplete(ownerA, orgA))
    // No PAdES signature added — behavior is exactly the pre-signing flatten path.
    expect(verifyPades(signed).signed).toBe(false)
    // Still a valid, loadable PDF (flatten + certificate page).
    expect((await PDFDocument.load(signed)).getPageCount()).toBe(2)
  })
})

describe('org-settings gate on the settings actions', () => {
  it('a plain member of a real org is redirected to /documents and no certificate is created', async () => {
    await clearCerts()
    const to = await asUser(sessionOf(memberA, orgA, 'member'), () => generatePlatformCertificate(generateForm('X')))
    expect(to).toBe('/documents')
    expect(await prisma.signingCertificate.count({ where: { orgId: orgA } })).toBe(0)
  })

  it('a platform admin with no org is redirected and no certificate is created', async () => {
    await clearCerts()
    const to = await asUser({ user: { id: ownerA, orgId: null, orgRole: null, isPlatformAdmin: true } }, () =>
      generatePlatformCertificate(generateForm('X')),
    )
    expect(to).toBe('/documents')
    expect(await prisma.signingCertificate.count({ where: { orgId: { in: [orgA, orgB] } } })).toBe(0)
  })

  it('writes to the session’s org even if the form names another org', async () => {
    await clearCerts()
    const fd = generateForm('Form Smuggle')
    fd.set('orgId', orgB)
    await asUser(sessionOf(ownerA, orgA, 'owner'), () => generatePlatformCertificate(fd))
    expect(await prisma.signingCertificate.count({ where: { orgId: orgA } })).toBe(1)
    expect(await prisma.signingCertificate.count({ where: { orgId: orgB } })).toBe(0)
  })
})

describe('full send→sign→finalize with per-org certificates', () => {
  it('seals with the document’s own org’s cert, never another org’s, and exposes no secrets', async () => {
    await clearCerts()
    const to = await asUser(sessionOf(ownerA, orgA, 'owner'), () =>
      generatePlatformCertificate(generateForm('Bevora Sign Test CA')),
    )
    expect(to).toBe('/settings/signing?saved=generated')

    // The settings view exposes ONLY public metadata — never key/passphrase/P12.
    const view = await getSigningConfigForClient(orgA)
    expect(view?.configured).toBe(true)
    expect(view?.subject).toContain('CN=Bevora Sign Test CA')
    expect(view?.fingerprint).toMatch(/^[0-9a-f]{64}$/)
    expect(JSON.stringify(view)).not.toMatch(/passphrase|p12Key|passphraseEnc|BEGIN|PRIVATE/i)
    expect(view as Record<string, unknown>).not.toHaveProperty('p12Key')
    expect(view as Record<string, unknown>).not.toHaveProperty('passphraseEnc')

    // Org A's completed document is sealed with org A's cert.
    const signed = await signedBytesOf(await makeSentAndComplete(ownerA, orgA))
    expect(Buffer.from(signed).includes('ETSI.CAdES.detached')).toBe(true)
    const v = verifyPades(signed)
    expect(v.signed).toBe(true)
    expect(v.byteRangeCoversFile).toBe(true)
    expect(v.valid).toBe(true)
    expect(v.signerSubject).toContain('CN=Bevora Sign Test CA')

    // Org B has no cert: its document is NOT sealed with org A's, and its view
    // shows nothing configured.
    expect((await getSigningConfigForClient(orgB))?.configured).toBe(false)
    const signedB = await signedBytesOf(await makeSentAndComplete(ownerB, orgB))
    expect(verifyPades(signedB).signed).toBe(false)
  })

  it('a new cert in one org deactivates only that org’s previous cert', async () => {
    await clearCerts()
    await asUser(sessionOf(ownerA, orgA, 'owner'), () => generatePlatformCertificate(generateForm('A1')))
    await asUser(sessionOf(ownerB, orgB, 'owner'), () => generatePlatformCertificate(generateForm('B1')))
    await asUser(sessionOf(ownerB, orgB, 'owner'), () => generatePlatformCertificate(generateForm('B2')))

    expect(await prisma.signingCertificate.count({ where: { orgId: orgA, active: true } })).toBe(1)
    const bRows = await prisma.signingCertificate.findMany({ where: { orgId: orgB }, orderBy: { createdAt: 'asc' } })
    expect(bRows.map((r) => r.active)).toEqual([false, true])
    expect((await getSigningConfigForClient(orgA))?.subject).toContain('CN=A1')
    expect((await getSigningConfigForClient(orgB))?.subject).toContain('CN=B2')

    // Org B's document is sealed with B2, not A1.
    const v = verifyPades(await signedBytesOf(await makeSentAndComplete(ownerB, orgB)))
    expect(v.signerSubject).toContain('CN=B2')
  })

  it('removing an org’s cert reverts only that org to unsealed', async () => {
    await clearCerts()
    await asUser(sessionOf(ownerA, orgA, 'owner'), () => generatePlatformCertificate(generateForm('A1')))
    await asUser(sessionOf(ownerB, orgB, 'owner'), () => generatePlatformCertificate(generateForm('B1')))
    await asUser(sessionOf(ownerA, orgA, 'owner'), () => removePlatformCertificate())

    expect(verifyPades(await signedBytesOf(await makeSentAndComplete(ownerA, orgA))).signed).toBe(false)
    expect(verifyPades(await signedBytesOf(await makeSentAndComplete(ownerB, orgB))).signed).toBe(true)
  })
})
