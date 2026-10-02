// @vitest-environment node
//
// Envelopes against the real dev Postgres + filesystem storage, with the mailer
// captured. Proves: an envelope only ever holds the creator's own drafts;
// setting signers replaces each draft's recipients, keeps placed fields for
// unchanged signers and reports the ones that lost theirs; sending skips
// unready documents and reports why, sends the rest, and emails each signer
// exactly ONCE listing their documents; a signer's single link shows only their
// own sent documents; status is derived from the documents.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
process.env.DATA_KEY ||= '0'.repeat(64)
process.env.STORAGE_DIR = '/tmp/ds-envelopes-' + Date.now()

const mail = vi.hoisted(() => ({
  sent: [] as { orgId: string | null; to: string; subject: string; text: string }[],
}))
vi.mock('@/lib/mailer', () => ({
  sendEmail: vi.fn(async (m: { orgId: string | null; to: string; subject: string; text: string }) => {
    mail.sent.push({ orgId: m.orgId, to: m.to, subject: m.subject, text: m.text })
    return { sent: true, via: 'shared' }
  }),
  isEmailConfigured: vi.fn(async () => true),
}))

import { PDFDocument } from 'pdf-lib'
import { prisma } from '../../src/lib/db'
import { createDocument, saveFields } from '../../src/server/documents/actions'
import {
  createEnvelope,
  addDocuments,
  removeDocument,
  setSigners,
  sendEnvelope,
  getEnvelope,
  listEnvelopes,
  getSignerEnvelope,
} from '../../src/server/envelopes/actions'

let orgId: string
let otherOrg: string
let owner: string
let colleague: string
const docIds: string[] = []
const envIds: string[] = []

const actor = () => ({ id: owner, orgId, orgRole: 'member' as const })

async function pdf(): Promise<Buffer> {
  const d = await PDFDocument.create()
  d.addPage([600, 800])
  return Buffer.from(await d.save())
}

async function draft(name: string, who = owner, org = orgId): Promise<string> {
  const { id } = await createDocument(who, org, name, await pdf())
  docIds.push(id)
  return id
}

async function newEnvelope(ids: string[], name = 'Onboarding pack'): Promise<string> {
  const res = await createEnvelope(actor(), { name, documentIds: ids })
  if (!res.ok) throw new Error(res.error)
  envIds.push(res.id)
  return res.id
}

// Give every recipient on a draft one signature field so it is ready to send.
async function placeFieldsForAll(docId: string) {
  const recs = await prisma.recipient.findMany({ where: { documentId: docId } })
  await saveFields(
    docId,
    recs.map((r, i) => ({ page: 1, type: 'signature' as const, x: 0.1, y: 0.1 + i * 0.1, w: 0.2, h: 0.08, value: '', recipientId: r.id })),
  )
}

beforeAll(async () => {
  const stamp = Date.now()
  orgId = (await prisma.organization.create({ data: { name: 'Env Org', slug: 'env-' + stamp } })).id
  otherOrg = (await prisma.organization.create({ data: { name: 'Env Other', slug: 'env-o-' + stamp } })).id
  owner = (await prisma.user.create({ data: { email: `env-owner-${stamp}@x.com`, name: 'Olive Owner', passwordHash: 'x', role: 'user' } })).id
  colleague = (await prisma.user.create({ data: { email: `env-col-${stamp}@x.com`, name: 'Col', passwordHash: 'x', role: 'user' } })).id
  await prisma.membership.createMany({
    data: [
      { orgId, userId: owner, role: 'member' },
      { orgId, userId: colleague, role: 'admin' },
    ],
  })
})

afterAll(async () => {
  if (docIds.length) await prisma.document.deleteMany({ where: { id: { in: docIds } } })
  if (envIds.length) await prisma.envelope.deleteMany({ where: { id: { in: envIds } } })
  await prisma.user.deleteMany({ where: { id: { in: [owner, colleague] } } })
  await prisma.organization.deleteMany({ where: { id: { in: [orgId, otherOrg] } } })
})

beforeEach(() => {
  mail.sent.length = 0
})

describe('creating an envelope', () => {
  it('holds the creator’s own drafts', async () => {
    const a = await draft('a.pdf')
    const b = await draft('b.pdf')
    const id = await newEnvelope([a, b])
    const view = await getEnvelope(actor(), id)
    expect(view?.documents.map((d) => d.name)).toEqual(['a.pdf', 'b.pdf'])
    expect(view?.status).toBe('draft')
  })

  it('refuses a colleague’s document, creating nothing', async () => {
    const mine = await draft('mine.pdf')
    const theirs = await draft('theirs.pdf', colleague)
    const before = await prisma.envelope.count()
    expect(await createEnvelope(actor(), { name: 'X', documentIds: [mine, theirs] })).toEqual({ ok: false, error: 'NOT_FOUND' })
    expect(await prisma.envelope.count()).toBe(before)
    expect((await prisma.document.findUnique({ where: { id: mine } }))?.envelopeId).toBeNull()
  })

  it('refuses a document already in another envelope', async () => {
    const a = await draft('once.pdf')
    await newEnvelope([a])
    expect(await createEnvelope(actor(), { name: 'Twice', documentIds: [a] })).toEqual({ ok: false, error: 'NOT_FOUND' })
  })

  it('someone else cannot see or change it, an org admin included', async () => {
    const id = await newEnvelope([await draft('private.pdf')])
    const admin = { id: colleague, orgId, orgRole: 'admin' as const }
    expect(await getEnvelope(admin, id)).toBeNull()
    expect(await setSigners(admin, id, [{ name: 'X', email: 'x@x.com' }])).toEqual({ ok: false, error: 'NOT_FOUND' })
    expect(await sendEnvelope(admin, id)).toEqual({ ok: false, error: 'NOT_FOUND' })
    expect((await listEnvelopes(admin)).map((e) => e.id)).not.toContain(id)
  })
})

describe('signers', () => {
  it('replace each draft’s recipients, keep fields for unchanged signers, report the rest', async () => {
    const a = await draft('contract.pdf')
    const b = await draft('nda.pdf')
    const id = await newEnvelope([a, b])
    await setSigners(actor(), id, [
      { name: 'Ann', email: 'ann@x.com' },
      { name: 'Bob', email: 'bob@x.com' },
    ])
    await placeFieldsForAll(a)
    const annToken = (await getEnvelope(actor(), id))!.signers.find((s) => s.email === 'ann@x.com')!.token

    const res = await setSigners(actor(), id, [
      { name: 'Ann Lee', email: 'ANN@x.com' },
      { name: 'Cy', email: 'cy@x.com' },
    ])
    expect(res).toEqual({ ok: true, unassigned: [{ documentId: a, name: 'contract.pdf', fields: 1 }], skipped: [] })

    const recs = await prisma.recipient.findMany({ where: { documentId: a }, orderBy: { orderIndex: 'asc' } })
    expect(recs.map((r) => [r.name, r.email])).toEqual([['Ann Lee', 'ann@x.com'], ['Cy', 'cy@x.com']])
    const fields = await prisma.field.findMany({ where: { documentId: a } })
    expect(fields.filter((f) => f.recipientId === recs[0].id)).toHaveLength(1)
    expect(fields.filter((f) => f.recipientId === null)).toHaveLength(1)

    // An unchanged signer keeps their link.
    const view = await getEnvelope(actor(), id)
    expect(view!.signers.find((s) => s.email === 'ann@x.com')!.token).toBe(annToken)
    expect(view!.signers.map((s) => s.email)).toEqual(['ann@x.com', 'cy@x.com'])
  })

  it('refuses an invalid signer list', async () => {
    const id = await newEnvelope([await draft('bad.pdf')])
    expect(await setSigners(actor(), id, [{ name: 'Ann', email: 'nope' }])).toEqual({ ok: false, error: 'INVALID' })
  })

  it('a document added later gets the envelope’s signers', async () => {
    const id = await newEnvelope([await draft('first.pdf')])
    await setSigners(actor(), id, [{ name: 'Dee', email: 'dee@x.com' }])
    const late = await draft('late.pdf')
    expect(await addDocuments(actor(), id, [late])).toEqual({ ok: true, added: 1 })
    expect((await prisma.recipient.findMany({ where: { documentId: late } })).map((r) => r.email)).toEqual(['dee@x.com'])
  })
})

describe('sending', () => {
  it('refuses with no signers', async () => {
    const id = await newEnvelope([await draft('lonely.pdf')])
    expect(await sendEnvelope(actor(), id)).toEqual({ ok: false, error: 'NO_SIGNERS' })
  })

  it('sends ready documents, skips unready ones with a reason, and emails each signer ONCE', async () => {
    const ready1 = await draft('ready-1.pdf')
    const ready2 = await draft('ready-2.pdf')
    const unready = await draft('unready.pdf')
    const id = await newEnvelope([ready1, ready2, unready])
    await setSigners(actor(), id, [
      { name: 'Ann', email: 'ann@x.com' },
      { name: 'Bob', email: 'bob@x.com' },
    ])
    await placeFieldsForAll(ready1)
    await placeFieldsForAll(ready2)

    const res = await sendEnvelope(actor(), id, { message: 'Both by Friday, please.', meta: { baseUrl: 'https://sign.test' } })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.sent.map((d) => d.name)).toEqual(['ready-1.pdf', 'ready-2.pdf'])
    expect(res.skipped).toEqual([{ documentId: unready, name: 'unready.pdf', reason: 'RECIPIENT_WITHOUT_FIELD' }])

    // One email per signer, not per document, sent as the envelope's org.
    expect(mail.sent.map((m) => m.to).sort()).toEqual(['ann@x.com', 'bob@x.com'])
    const ann = mail.sent.find((m) => m.to === 'ann@x.com')!
    expect(ann.orgId).toBe(orgId)
    expect(ann.subject).toContain('2 documents')
    expect(ann.text).toContain('ready-1.pdf')
    expect(ann.text).toContain('ready-2.pdf')
    expect(ann.text).not.toContain('unready.pdf')
    expect(ann.text).toContain('Both by Friday, please.')
    const annToken = (await getEnvelope(actor(), id))!.signers.find((s) => s.email === 'ann@x.com')!.token
    expect(ann.text).toContain(`https://sign.test/e/${annToken}`)

    // Status is derived: two sent, one draft → partial.
    expect((await getEnvelope(actor(), id))?.status).toBe('partial')
    expect((await prisma.document.findUnique({ where: { id: ready1 } }))?.status).toBe('sent')
    expect((await prisma.document.findUnique({ where: { id: unready } }))?.status).toBe('draft')

    // The email is audited on every document it covered.
    const notes = await prisma.auditEvent.findMany({ where: { documentId: ready1, action: 'notify' } })
    expect(notes.map((n) => (n.detail as { to: string }).to).sort()).toEqual(['ann@x.com', 'bob@x.com'])
  })

  it('a sent document can’t be removed from the envelope, a draft can', async () => {
    const sentDoc = await draft('gone.pdf')
    const keepDraft = await draft('stay.pdf')
    const id = await newEnvelope([sentDoc, keepDraft])
    await setSigners(actor(), id, [{ name: 'Ann', email: 'ann@x.com' }])
    await placeFieldsForAll(sentDoc)
    await sendEnvelope(actor(), id)
    expect(await removeDocument(actor(), id, sentDoc)).toEqual({ ok: false, error: 'NOT_DRAFT' })
    expect(await removeDocument(actor(), id, keepDraft)).toEqual({ ok: true })
  })
})

describe('a signer’s single link', () => {
  it('lists only that signer’s sent documents, each with its own signing link', async () => {
    const both = await draft('both.pdf')
    const annOnly = await draft('ann-only.pdf')
    const notSent = await draft('not-sent.pdf')
    const id = await newEnvelope([both, annOnly, notSent])
    await setSigners(actor(), id, [
      { name: 'Ann', email: 'ann@x.com' },
      { name: 'Bob', email: 'bob@x.com' },
    ])
    // ann-only: drop Bob from this one document directly.
    await prisma.recipient.deleteMany({ where: { documentId: annOnly, email: 'bob@x.com' } })
    await placeFieldsForAll(both)
    await placeFieldsForAll(annOnly)
    await sendEnvelope(actor(), id)

    const signers = (await getEnvelope(actor(), id))!.signers
    const annView = await getSignerEnvelope(signers.find((s) => s.email === 'ann@x.com')!.token)
    const bobView = await getSignerEnvelope(signers.find((s) => s.email === 'bob@x.com')!.token)

    expect(annView?.signerName).toBe('Ann')
    expect(annView?.senderName).toBe('Olive Owner')
    expect(annView?.documents.map((d) => d.name)).toEqual(['both.pdf', 'ann-only.pdf'])
    expect(bobView?.documents.map((d) => d.name)).toEqual(['both.pdf'])

    // Each entry's link is that signer's own recipient token on that document.
    const annRec = await prisma.recipient.findFirst({ where: { documentId: both, email: 'ann@x.com' } })
    expect(annView?.documents[0].signToken).toBe(annRec?.token)
  })

  it('an unknown link shows nothing', async () => {
    expect(await getSignerEnvelope('not-a-real-token')).toBeNull()
  })
})
