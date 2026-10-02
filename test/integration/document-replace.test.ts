// @vitest-environment node
//
// Replacing a draft's PDF (keeping recipients) and the stored invitation note,
// against the real dev Postgres + filesystem storage.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
process.env.DATA_KEY ||= '0'.repeat(64)
process.env.STORAGE_DIR = '/tmp/ds-replace-' + Date.now()

const authMock = vi.hoisted(() => ({ session: null as unknown }))
vi.mock('@/auth', () => ({ auth: () => Promise.resolve(authMock.session) }))

import { PDFDocument } from 'pdf-lib'
import { prisma } from '../../src/lib/db'
import { getObject } from '../../src/lib/storage'
import { sha256hex } from '../../src/lib/hash'
import {
  createDocument,
  saveRecipients,
  saveFields,
  sendForSignature,
  replaceDocumentFile,
} from '../../src/server/documents/actions'

let orgId: string
let owner: string
let colleague: string
const docIds: string[] = []

async function pdf(pages: number): Promise<Buffer> {
  const d = await PDFDocument.create()
  for (let i = 0; i < pages; i++) d.addPage([600, 800])
  return Buffer.from(await d.save())
}

async function draftWithRecipient(pages: number) {
  const { id } = await createDocument(owner, orgId, 'first.pdf', await pdf(pages))
  docIds.push(id)
  const [rec] = await saveRecipients(id, [{ name: 'Signer', email: `s${Date.now()}@x.com` }])
  return { id, rec }
}

beforeAll(async () => {
  const stamp = Date.now()
  orgId = (await prisma.organization.create({ data: { name: 'Replace Org', slug: 'replace-' + stamp } })).id
  owner = (await prisma.user.create({ data: { email: `rep-owner-${stamp}@x.com`, name: 'Owner', passwordHash: 'x', role: 'user' } })).id
  colleague = (await prisma.user.create({ data: { email: `rep-col-${stamp}@x.com`, name: 'Col', passwordHash: 'x', role: 'user' } })).id
  await prisma.membership.createMany({
    data: [
      { orgId, userId: owner, role: 'member' },
      { orgId, userId: colleague, role: 'admin' },
    ],
  })
})

afterAll(async () => {
  if (docIds.length) await prisma.document.deleteMany({ where: { id: { in: docIds } } })
  await prisma.user.deleteMany({ where: { id: { in: [owner, colleague] } } })
  await prisma.organization.deleteMany({ where: { id: orgId } })
})

describe('replaceDocumentFile', () => {
  it('swaps the file, keeps recipients, drops only fields on pages that no longer exist, audits the swap', async () => {
    const { id, rec } = await draftWithRecipient(3)
    await saveFields(id, [
      { page: 1, type: 'signature', x: 0.1, y: 0.1, w: 0.2, h: 0.08, value: '', recipientId: rec.id },
      { page: 3, type: 'date', x: 0.1, y: 0.1, w: 0.2, h: 0.05, value: '', recipientId: rec.id },
    ])
    const before = await prisma.document.findUnique({ where: { id } })
    const next = await pdf(2)

    const res = await replaceDocumentFile(id, owner, 'second.pdf', next)
    expect(res).toEqual({ pageCount: 2, removedFields: 1 })

    const after = await prisma.document.findUnique({ where: { id }, include: { recipients: true, fields: true } })
    expect(after?.originalName).toBe('second.pdf')
    expect(after?.pageCount).toBe(2)
    expect(after?.originalSha256).toBe(sha256hex(next))
    expect(after?.originalKey).not.toBe(before?.originalKey)
    expect(Buffer.from(await getObject(after!.originalKey)).equals(next)).toBe(true)
    await expect(getObject(before!.originalKey)).rejects.toThrow()
    expect(after?.recipients.map((r) => r.id)).toEqual([rec.id])
    expect(after?.fields.map((f) => f.page)).toEqual([1])

    const audit = await prisma.auditEvent.findFirst({ where: { documentId: id, action: 'upload' }, orderBy: { createdAt: 'desc' } })
    expect(audit?.detail).toMatchObject({ replaced: true, previousName: 'first.pdf', previousSha256: before?.originalSha256, removedFields: 1 })
  })

  it('refuses a sent document and leaves it untouched', async () => {
    const { id, rec } = await draftWithRecipient(1)
    await saveFields(id, [{ page: 1, type: 'signature', x: 0.1, y: 0.1, w: 0.2, h: 0.08, value: '', recipientId: rec.id }])
    await sendForSignature(id, owner)
    const before = await prisma.document.findUnique({ where: { id } })
    await expect(replaceDocumentFile(id, owner, 'x.pdf', await pdf(1))).rejects.toThrow('NOT_DRAFT')
    expect((await prisma.document.findUnique({ where: { id } }))?.originalKey).toBe(before?.originalKey)
  })

  it('refuses a file that is not a PDF, writing nothing', async () => {
    const { id } = await draftWithRecipient(1)
    const before = await prisma.document.findUnique({ where: { id } })
    await expect(replaceDocumentFile(id, owner, 'x.pdf', Buffer.from('not a pdf'))).rejects.toThrow('INVALID_PDF')
    expect((await prisma.document.findUnique({ where: { id } }))?.originalSha256).toBe(before?.originalSha256)
  })

  it('the route refuses anyone but the uploader (an org admin included)', async () => {
    const { id } = await draftWithRecipient(1)
    authMock.session = { user: { id: colleague, orgId, orgRole: 'admin' } }
    const { POST } = await import('../../src/app/api/documents/[id]/replace/route')
    const form = new FormData()
    form.append('file', new File([new Uint8Array(await pdf(1))], 'y.pdf', { type: 'application/pdf' }))
    const res = await POST(new Request(`http://t/api/documents/${id}/replace`, { method: 'POST', body: form }) as never, {
      params: Promise.resolve({ id }),
    })
    expect(res.status).toBe(403)
  })
})

describe('invitation note', () => {
  it('is stored on send, trimmed', async () => {
    const { id, rec } = await draftWithRecipient(1)
    await saveFields(id, [{ page: 1, type: 'signature', x: 0.1, y: 0.1, w: 0.2, h: 0.08, value: '', recipientId: rec.id }])
    await sendForSignature(id, owner, {}, { message: '  Please sign by Friday.  ' })
    expect((await prisma.document.findUnique({ where: { id } }))?.inviteMessage).toBe('Please sign by Friday.')
  })

  it('an empty note is stored as none', async () => {
    const { id, rec } = await draftWithRecipient(1)
    await saveFields(id, [{ page: 1, type: 'signature', x: 0.1, y: 0.1, w: 0.2, h: 0.08, value: '', recipientId: rec.id }])
    await sendForSignature(id, owner, {}, { message: '' })
    expect((await prisma.document.findUnique({ where: { id } }))?.inviteMessage).toBeNull()
  })
})
