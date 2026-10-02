// @vitest-environment node
//
// env.SIGNING_FAIL_CLOSED=true behavior ONLY. This is a SEPARATE file from
// signing-pades.test.ts on purpose: src/env.ts parses process.env exactly
// once, at import time, into a module-level constant. Static `import`
// declarations are hoisted ahead of any of this file's own top-level code
// (confirmed: setting process.env before a static import of src/env.ts's
// dependents here did NOT take effect — the flag read back as off), so every
// app module is imported dynamically, inside `beforeAll`, AFTER the env var
// is set. See signing-pades.test.ts for the default (off) behavior.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'

process.env.DATA_KEY ||= '0'.repeat(64)
process.env.STORAGE_DIR = '/tmp/ds-failclosed-' + Date.now()
process.env.SIGNING_FAIL_CLOSED = 'true'

let createDocument: typeof import('../../src/server/documents/actions').createDocument
let saveFields: typeof import('../../src/server/documents/actions').saveFields
let saveRecipients: typeof import('../../src/server/documents/actions').saveRecipients
let sendForSignature: typeof import('../../src/server/documents/actions').sendForSignature
let completeSigning: typeof import('../../src/server/documents/signing').completeSigning
let prisma: typeof import('../../src/lib/db').prisma
let maybePadesSign: typeof import('../../src/lib/signing-config').maybePadesSign
let invalidateSigningCache: typeof import('../../src/lib/signing-config').invalidateSigningCache
let PDFDocument: typeof import('pdf-lib').PDFDocument

let org: string
let owner: string
const documentIds: string[] = []

const PNG_1x1 =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC'

async function samplePdfBytes(): Promise<Buffer> {
  const d = await PDFDocument.create()
  d.addPage([600, 800])
  return Buffer.from(await d.save())
}

beforeAll(async () => {
  ;({ PDFDocument } = await import('pdf-lib'))
  ;({ createDocument, saveFields, saveRecipients, sendForSignature } = await import(
    '../../src/server/documents/actions'
  ))
  ;({ completeSigning } = await import('../../src/server/documents/signing'))
  ;({ prisma } = await import('../../src/lib/db'))
  ;({ maybePadesSign, invalidateSigningCache } = await import('../../src/lib/signing-config'))

  const stamp = Date.now()
  org = (await prisma.organization.create({ data: { name: 'FailClosed Org', slug: 'fc-' + stamp } })).id
  owner = (await prisma.user.create({ data: { email: `fc-owner-${stamp}@x.com`, name: 'owner', passwordHash: 'x', role: 'user' } })).id
  await prisma.membership.create({ data: { orgId: org, userId: owner, role: 'owner' } })
})

afterAll(async () => {
  await prisma.signingCertificate.deleteMany({ where: { orgId: org } })
  if (documentIds.length) await prisma.document.deleteMany({ where: { id: { in: documentIds } } })
  await prisma.user.deleteMany({ where: { id: owner } })
  await prisma.organization.deleteMany({ where: { id: org } })
})

async function clearCerts() {
  await prisma.signingCertificate.deleteMany({ where: { orgId: org } })
  invalidateSigningCache()
}

describe('SIGNING_FAIL_CLOSED=true: an org with no certificate refuses to seal', () => {
  it('maybePadesSign THROWS SIGNING_NOT_CONFIGURED when the org has no cert, instead of returning the bytes unchanged', async () => {
    await clearCerts()
    const bytes = await samplePdfBytes()
    await expect(maybePadesSign(bytes, org)).rejects.toThrow('SIGNING_NOT_CONFIGURED')
  })

  it('a document whose last recipient signs is NOT completed when its org has no cert — the signature is kept, but the document stays `sent`', async () => {
    await clearCerts()
    const { id } = await createDocument(owner, org, 'fc.pdf', await samplePdfBytes())
    documentIds.push(id)
    const [rec] = await saveRecipients(id, [{ name: 'Signer', email: `fc-s${Date.now()}@x.com` }])
    await saveFields(id, [
      { page: 1, type: 'signature', x: 0.1, y: 0.1, w: 0.2, h: 0.08, value: '', recipientId: rec.id },
    ])
    const [link] = await sendForSignature(id, owner)
    const field = await prisma.field.findFirst({ where: { recipientId: rec.id } })
    const res = await completeSigning(link.token, [{ fieldId: field!.id, value: PNG_1x1 }])

    // The recipient's own act of signing is real and already committed —
    // losing it just because the org's admin hasn't configured a certificate
    // yet would be its own kind of data loss, so `ok` stays true.
    if (!res.ok) throw new Error(`expected ok, got reason: ${res.reason}`)
    expect(res.completed).toBe(false)

    const doc = await prisma.document.findUnique({ where: { id } })
    expect(doc?.status).toBe('sent')
    expect(doc?.signedKey).toBeNull()
    const recipientAfter = await prisma.recipient.findUnique({ where: { id: rec.id } })
    expect(recipientAfter?.status).toBe('signed')
  })
})

describe('a certificate with no org (orgId NULL) is never usable by any org, never a platform-wide fallback', () => {
  it('an org with only an UNASSIGNED active certificate still fails closed — that row is never served to any org', async () => {
    await clearCerts()
    // Simulate the one legitimate way an orgId-NULL row can exist: the
    // multi-org migration path leaves a legacy certificate unassigned. It
    // must never be readable as "this org's" certificate for ANY org,
    // including by coincidence of being the only active row in the table.
    await prisma.signingCertificate.create({
      data: {
        id: 'orphan-cert-' + Date.now(),
        orgId: null,
        active: true,
        p12Key: 'signing/orphan/does-not-matter.p12',
        passphraseEnc: 'unused',
        subject: 'CN=Orphan',
        issuer: 'CN=Orphan',
        notBefore: new Date('2020-01-01'),
        notAfter: new Date('2099-01-01'),
        fingerprint: 'f'.repeat(64),
        origin: 'uploaded',
      },
    })

    const bytes = await samplePdfBytes()
    // Must behave EXACTLY as if no certificate existed at all for this org —
    // not pick up the orphaned row.
    await expect(maybePadesSign(bytes, org)).rejects.toThrow('SIGNING_NOT_CONFIGURED')

    await prisma.signingCertificate.deleteMany({ where: { orgId: null } })
  })
})
