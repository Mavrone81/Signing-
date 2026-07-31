// @vitest-environment node
//
// PAdES/PKI end-to-end: the "activate when configured / else unchanged"
// guarantee, the full send→sign→finalize seal, the platform-admin gate on the
// Settings → Signing actions, and the no-secrets settings view. Real Postgres +
// filesystem + pdf-lib, like the other integration tests.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
process.env.DATA_KEY ||= '0'.repeat(64)
process.env.STORAGE_DIR = '/tmp/ds-pades-' + Date.now()

// Mutable mock session for the platform-admin gate on the settings actions.
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

let orgId: string
let userId: string
const documentIds: string[] = []

const PNG_1x1 =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC'

async function samplePdfBytes(): Promise<Buffer> {
  const d = await PDFDocument.create()
  d.addPage([600, 800])
  return Buffer.from(await d.save())
}

async function makeSentAndComplete(): Promise<string> {
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

beforeAll(async () => {
  const org = await prisma.organization.create({ data: { name: 'PAdES Org', slug: 'pades-' + Date.now() } })
  orgId = org.id
  const u = await prisma.user.create({
    data: { email: 'pades' + Date.now() + '@x.com', name: 'PAdES', passwordHash: 'x', role: 'admin', isPlatformAdmin: true },
  })
  userId = u.id
  await prisma.membership.create({ data: { orgId, userId, role: 'member' } })
})

afterAll(async () => {
  await prisma.signingCertificate.deleteMany({})
  if (documentIds.length) await prisma.document.deleteMany({ where: { id: { in: documentIds } } })
  await prisma.membership.deleteMany({ where: { userId } })
  await prisma.user.deleteMany({ where: { id: userId } })
  await prisma.organization.deleteMany({ where: { id: orgId } })
})

describe('activate-when-configured / else unchanged', () => {
  it('maybePadesSign returns the bytes UNCHANGED when no cert is configured', async () => {
    await prisma.signingCertificate.deleteMany({})
    invalidateSigningCache()
    const bytes = await samplePdfBytes()
    const out = await maybePadesSign(bytes)
    expect(Buffer.from(out).equals(bytes)).toBe(true)
    expect(verifyPades(out).signed).toBe(false)
  })

  it('finalizes a completed document WITHOUT a signature when no cert is configured', async () => {
    await prisma.signingCertificate.deleteMany({})
    invalidateSigningCache()
    const id = await makeSentAndComplete()
    const doc = await prisma.document.findUnique({ where: { id } })
    expect(doc?.status).toBe('completed')
    const signed = await getObject(doc!.signedKey!)
    // No PAdES signature added — behavior is exactly the pre-signing flatten path.
    expect(verifyPades(signed).signed).toBe(false)
    // Still a valid, loadable PDF (flatten + certificate page).
    expect((await PDFDocument.load(signed)).getPageCount()).toBe(2)
  })
})

describe('platform-admin gate on the settings actions', () => {
  it('a non-admin is redirected to /documents and no certificate is created', async () => {
    await prisma.signingCertificate.deleteMany({})
    authMock.session = { user: { id: userId, isPlatformAdmin: false } }
    let redirectedTo: string | undefined
    try {
      await generatePlatformCertificate(new FormData())
    } catch (e) {
      redirectedTo = (e as { url?: string }).url
    }
    expect(redirectedTo).toBe('/documents')
    expect(await prisma.signingCertificate.count()).toBe(0)
  })
})

describe('full send→sign→finalize with a configured cert', () => {
  it('seals the completed PDF (ETSI.CAdES.detached, whole-file ByteRange, verifiable) and exposes no secrets', async () => {
    // Configure a platform cert AS a platform admin, via the real settings action.
    await prisma.signingCertificate.deleteMany({})
    authMock.session = { user: { id: userId, isPlatformAdmin: true } }
    const fd = new FormData()
    fd.set('commonName', 'Bevora Sign Test CA')
    fd.set('years', '3')
    try {
      await generatePlatformCertificate(fd)
    } catch (e) {
      expect((e as { url?: string }).url).toBe('/settings/signing?saved=generated')
    }
    invalidateSigningCache()
    expect(await prisma.signingCertificate.count()).toBe(1)

    // The settings view exposes ONLY public metadata — never key/passphrase/P12.
    const view = await getSigningConfigForClient()
    expect(view?.configured).toBe(true)
    expect(view?.subject).toContain('CN=Bevora Sign Test CA')
    expect(view?.fingerprint).toMatch(/^[0-9a-f]{64}$/)
    expect(JSON.stringify(view)).not.toMatch(/passphrase|p12Key|passphraseEnc|BEGIN|PRIVATE/i)
    expect(view as Record<string, unknown>).not.toHaveProperty('p12Key')
    expect(view as Record<string, unknown>).not.toHaveProperty('passphraseEnc')

    // Finalize a document → the stored completed PDF is PAdES-sealed.
    const id = await makeSentAndComplete()
    const doc = await prisma.document.findUnique({ where: { id } })
    expect(doc?.status).toBe('completed')
    const signed = await getObject(doc!.signedKey!)
    expect(Buffer.from(signed).includes('ETSI.CAdES.detached')).toBe(true)
    const v = verifyPades(signed)
    expect(v.signed).toBe(true)
    expect(v.byteRangeCoversFile).toBe(true)
    expect(v.valid).toBe(true)
    expect(v.signerSubject).toContain('CN=Bevora Sign Test CA')

    // Removing the cert reverts to the flatten-only (unsigned) path.
    try {
      await removePlatformCertificate()
    } catch {
      /* redirect sentinel */
    }
    invalidateSigningCache()
    const id2 = await makeSentAndComplete()
    const doc2 = await prisma.document.findUnique({ where: { id: id2 } })
    const signed2 = await getObject(doc2!.signedKey!)
    expect(verifyPades(signed2).signed).toBe(false)
  })
})
