// @vitest-environment node
//
// Phase 4b — Templates. Runs in the plain Node environment (not jsdom) for the
// same cross-realm Buffer/pdf-lib reason as documents.test.ts, and hits a real
// Postgres + filesystem.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
process.env.DATA_KEY ||= '0'.repeat(64); process.env.STORAGE_DIR='/tmp/ds-tpl-'+Date.now()

const authMock = vi.hoisted(() => ({
  session: null as
    | null
    | {
        user: {
          id: string
          role: 'admin' | 'user'
          orgId: string | null
          orgRole: 'owner' | 'admin' | 'member' | null
          isPlatformAdmin?: boolean
        }
      },
}))
vi.mock('@/auth', () => ({ auth: () => Promise.resolve(authMock.session) }))

import { PDFDocument } from 'pdf-lib'
import { createDocument, saveFields, saveRecipients } from '../../src/server/documents/actions'
import {
  saveAsTemplate,
  createDocumentFromTemplate,
  listTemplates,
  deleteTemplate,
} from '../../src/server/templates/actions'
import { prisma } from '../../src/lib/db'
import { getObject } from '../../src/lib/storage'

let orgId: string
let ownerId: string
// A plain member of the same org who does NOT own the source document.
let memberId: string
const documentIds: string[] = []
const templateIds: string[] = []
const userIds: string[] = []
const orgIds: string[] = []

async function samplePdfBytes(pages = 1): Promise<Buffer> {
  const d = await PDFDocument.create()
  for (let i = 0; i < pages; i++) d.addPage([600, 800])
  return Buffer.from(await d.save())
}

function actor(id: string, orgRole: 'owner' | 'admin' | 'member', org = orgId) {
  return { id, orgId: org, orgRole }
}

beforeAll(async () => {
  const org = await prisma.organization.create({ data: { name: 'Tpl Org', slug: 'tpl-' + Date.now() } })
  orgId = org.id
  orgIds.push(org.id)

  const owner = await prisma.user.create({ data: { email: 'tplowner' + Date.now() + '@x.com', name: 'Owner', passwordHash: 'x', role: 'user' } })
  ownerId = owner.id
  userIds.push(owner.id)
  await prisma.membership.create({ data: { orgId, userId: ownerId, role: 'member' } })

  const member = await prisma.user.create({ data: { email: 'tplmember' + Date.now() + '@x.com', name: 'Member', passwordHash: 'x', role: 'user' } })
  memberId = member.id
  userIds.push(member.id)
  await prisma.membership.create({ data: { orgId, userId: memberId, role: 'member' } })
})

afterAll(async () => {
  // Templates FK org; documents FK org/user (RESTRICT) — remove children first.
  if (templateIds.length) await prisma.template.deleteMany({ where: { id: { in: templateIds } } })
  if (documentIds.length) await prisma.document.deleteMany({ where: { id: { in: documentIds } } })
  if (userIds.length) await prisma.user.deleteMany({ where: { id: { in: userIds } } })
  if (orgIds.length) await prisma.organization.deleteMany({ where: { id: { in: orgIds } } })
})

// Build a two-recipient doc with one field per recipient plus a self field.
async function buildSourceDoc(name = 'src.pdf') {
  const bytes = await samplePdfBytes(2)
  const { id } = await createDocument(ownerId, orgId, name, bytes)
  documentIds.push(id)
  const [alice, bob] = await saveRecipients(id, [
    { name: 'Alice', email: 'a@x.com', orderIndex: 0 },
    { name: 'Bob', email: 'b@x.com', orderIndex: 1 },
  ])
  await saveFields(id, [
    { page: 1, type: 'signature', x: 0.1, y: 0.1, w: 0.2, h: 0.08, value: '', recipientId: alice.id },
    { page: 2, type: 'date', x: 0.5, y: 0.5, w: 0.18, h: 0.05, value: '2026-01-01', recipientId: bob.id },
    { page: 1, type: 'text', x: 0.3, y: 0.3, w: 0.25, h: 0.05, value: 'self', required: false },
  ])
  return { id, bytes, alice, bob }
}

describe('saveAsTemplate', () => {
  it('copies the PDF into its OWN blob and mirrors fields + roles with roleKey wiring', async () => {
    const src = await buildSourceDoc('save-as.pdf')
    const srcDoc = await prisma.document.findUnique({ where: { id: src.id } })

    const tpl = await saveAsTemplate(src.id, '  NDA  ', '  Standard NDA  ', actor(ownerId, 'member'))
    templateIds.push(tpl.id)
    expect(tpl.name).toBe('NDA') // trimmed

    const row = await prisma.template.findUnique({
      where: { id: tpl.id },
      include: { templateFields: true, templateRoles: { orderBy: { orderIndex: 'asc' } } },
    })
    expect(row?.orgId).toBe(orgId)
    expect(row?.description).toBe('Standard NDA') // trimmed
    expect(row?.pageCount).toBe(2)
    expect(row?.createdById).toBe(ownerId)

    // Template PDF is a SEPARATE blob (distinct key), byte-identical to the source.
    expect(row?.storageKey).not.toBe(srcDoc?.originalKey)
    expect(row?.storageKey).toContain(tpl.id)
    const tplBytes = await getObject(row!.storageKey)
    expect(Buffer.compare(tplBytes, src.bytes)).toBe(0)

    // Two roles, matching the recipients' name + orderIndex.
    expect(row?.templateRoles.map((r) => r.name)).toEqual(['Alice', 'Bob'])
    expect(row?.templateRoles.map((r) => r.orderIndex)).toEqual([0, 1])
    const aliceRole = row!.templateRoles[0]
    const bobRole = row!.templateRoles[1]
    expect(aliceRole.roleKey).toBeTruthy()
    expect(bobRole.roleKey).not.toBe(aliceRole.roleKey)

    // Three fields; assigned ones carry their role's roleKey, the self field null.
    const byType = Object.fromEntries(row!.templateFields.map((f) => [f.type, f]))
    expect(byType.signature.roleKey).toBe(aliceRole.roleKey)
    expect(byType.date.roleKey).toBe(bobRole.roleKey)
    expect(byType.text.roleKey).toBeNull()
    expect(byType.text.required).toBe(false)
  })

  it('templates a self-sign doc (no recipients) with no roles', async () => {
    const bytes = await samplePdfBytes()
    const { id } = await createDocument(ownerId, orgId, 'selfsign.pdf', bytes)
    documentIds.push(id)
    await saveFields(id, [{ page: 1, type: 'text', x: 0.1, y: 0.1, w: 0.3, h: 0.05, value: 'hi' }])

    const tpl = await saveAsTemplate(id, 'Solo', null, actor(ownerId, 'member'))
    templateIds.push(tpl.id)
    const row = await prisma.template.findUnique({
      where: { id: tpl.id },
      include: { templateFields: true, templateRoles: true },
    })
    expect(row?.templateRoles).toHaveLength(0)
    expect(row?.templateFields).toHaveLength(1)
    expect(row?.templateFields[0].roleKey).toBeNull()
  })

  it('rejects an empty name (INVALID_NAME)', async () => {
    const src = await buildSourceDoc('emptyname.pdf')
    await expect(saveAsTemplate(src.id, '   ', null, actor(ownerId, 'member'))).rejects.toThrow('INVALID_NAME')
  })

  it('FORBIDDEN for a same-org member who does not own the source document', async () => {
    const src = await buildSourceDoc('notmine.pdf')
    // memberId is in the same org but is not the doc owner and not an admin.
    await expect(saveAsTemplate(src.id, 'Nope', null, actor(memberId, 'member'))).rejects.toThrow('FORBIDDEN')
  })
})

describe('createDocumentFromTemplate', () => {
  it('creates a draft doc with fields + recipients wired by roleKey and a DISTINCT blob', async () => {
    const src = await buildSourceDoc('for-use.pdf')
    const tpl = await saveAsTemplate(src.id, 'Reusable', null, actor(ownerId, 'member'))
    templateIds.push(tpl.id)
    const tplRow = await prisma.template.findUnique({ where: { id: tpl.id } })

    // A DIFFERENT member of the org uses it (templates are org-wide shared).
    const { documentId } = await createDocumentFromTemplate(tpl.id, actor(memberId, 'member'))
    documentIds.push(documentId)

    const doc = await prisma.document.findUnique({
      where: { id: documentId },
      include: { fields: true, recipients: { orderBy: { orderIndex: 'asc' } } },
    })
    expect(doc?.status).toBe('draft')
    expect(doc?.ownerId).toBe(memberId)
    expect(doc?.orgId).toBe(orgId)
    expect(doc?.originalName).toBe('Reusable')
    expect(doc?.pageCount).toBe(2)

    // Blob is DISTINCT from the template's (different key) but byte-identical.
    expect(doc?.originalKey).not.toBe(tplRow?.storageKey)
    const docBytes = await getObject(doc!.originalKey)
    const tplBytes = await getObject(tplRow!.storageKey)
    expect(Buffer.compare(docBytes, tplBytes)).toBe(0)

    // Two recipients, emails blank for the sender to fill.
    expect(doc?.recipients.map((r) => r.name)).toEqual(['Alice', 'Bob'])
    expect(doc?.recipients.every((r) => r.email === '')).toBe(true)
    expect(doc?.recipients.every((r) => r.status === 'pending')).toBe(true)
    const aliceRec = doc!.recipients[0]
    const bobRec = doc!.recipients[1]

    // Fields re-wired onto the NEW recipient ids; the self field stays null.
    const byType = Object.fromEntries(doc!.fields.map((f) => [f.type, f]))
    expect(byType.signature.recipientId).toBe(aliceRec.id)
    expect(byType.date.recipientId).toBe(bobRec.id)
    expect(byType.text.recipientId).toBeNull()

    // An audit event records the template origin.
    const events = await prisma.auditEvent.findMany({ where: { documentId, action: 'upload' } })
    expect(events).toHaveLength(1)
    expect((events[0].detail as { fromTemplateId?: string })?.fromTemplateId).toBe(tpl.id)
  })

  it('deleting the source document leaves the template PDF intact (separate blobs)', async () => {
    const src = await buildSourceDoc('orphan-check.pdf')
    const tpl = await saveAsTemplate(src.id, 'Durable', null, actor(ownerId, 'member'))
    templateIds.push(tpl.id)

    // Remove the source doc entirely; the template's own blob must survive.
    await prisma.document.delete({ where: { id: src.id } })
    documentIds.splice(documentIds.indexOf(src.id), 1)

    const row = await prisma.template.findUnique({ where: { id: tpl.id } })
    const stillThere = await getObject(row!.storageKey)
    expect(Buffer.compare(stillThere, src.bytes)).toBe(0)
    // ...and the template is still usable.
    const { documentId } = await createDocumentFromTemplate(tpl.id, actor(ownerId, 'member'))
    documentIds.push(documentId)
    expect((await prisma.document.findUnique({ where: { id: documentId } }))?.status).toBe('draft')
  })
})

describe('listTemplates', () => {
  it('is org-scoped and returns field/role counts', async () => {
    const rows = await listTemplates(actor(memberId, 'member'))
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.every((t) => t.orgId === orgId)).toBe(true)
    const withRoles = rows.find((t) => t._count.templateRoles === 2)
    expect(withRoles).toBeTruthy()
  })
})

describe('deleteTemplate authz', () => {
  it('a same-org member who is NOT the creator cannot delete (FORBIDDEN)', async () => {
    const src = await buildSourceDoc('del-authz.pdf')
    const tpl = await saveAsTemplate(src.id, 'Guarded', null, actor(ownerId, 'member'))
    templateIds.push(tpl.id)
    // memberId did not create it and is a plain member → forbidden.
    await expect(deleteTemplate(tpl.id, actor(memberId, 'member'))).rejects.toThrow('FORBIDDEN')
    expect(await prisma.template.findUnique({ where: { id: tpl.id } })).not.toBeNull()
  })

  it('the creator can delete it (and its blob + children are gone)', async () => {
    const src = await buildSourceDoc('del-creator.pdf')
    const tpl = await saveAsTemplate(src.id, 'Mine', null, actor(ownerId, 'member'))
    const row = await prisma.template.findUnique({ where: { id: tpl.id } })
    await deleteTemplate(tpl.id, actor(ownerId, 'member'))
    expect(await prisma.template.findUnique({ where: { id: tpl.id } })).toBeNull()
    // children cascaded
    expect(await prisma.templateField.count({ where: { templateId: tpl.id } })).toBe(0)
    expect(await prisma.templateRole.count({ where: { templateId: tpl.id } })).toBe(0)
    // blob removed
    await expect(getObject(row!.storageKey)).rejects.toThrow()
  })

  it('an org owner/admin can delete another member\'s template', async () => {
    const src = await buildSourceDoc('del-admin.pdf')
    const tpl = await saveAsTemplate(src.id, 'ByOwner', null, actor(ownerId, 'member'))
    // memberId acting as an org admin can delete the owner's template.
    await deleteTemplate(tpl.id, actor(memberId, 'admin'))
    expect(await prisma.template.findUnique({ where: { id: tpl.id } })).toBeNull()
  })
})

// SECURITY: a user in org B must never read/use/delete an org A template.
describe('cross-tenant isolation', () => {
  let orgB: string
  let userB: string
  let tplAId: string

  beforeAll(async () => {
    const ob = await prisma.organization.create({ data: { name: 'Tpl Org B', slug: 'tplb-' + Date.now() } })
    orgB = ob.id
    orgIds.push(ob.id)
    const ub = await prisma.user.create({ data: { email: 'tplb' + Date.now() + '@x.com', name: 'B', passwordHash: 'x', role: 'user' } })
    userB = ub.id
    userIds.push(ub.id)
    await prisma.membership.create({ data: { orgId: orgB, userId: userB, role: 'owner' } })

    const src = await buildSourceDoc('tenant.pdf') // owned by ownerId in orgId (org A)
    const tpl = await saveAsTemplate(src.id, 'SecretA', null, actor(ownerId, 'member'))
    tplAId = tpl.id
    templateIds.push(tpl.id)
  })

  it('createDocumentFromTemplate NOT_FOUND for a user in another org', async () => {
    await expect(
      createDocumentFromTemplate(tplAId, { id: userB, orgId: orgB, orgRole: 'owner' }),
    ).rejects.toThrow('NOT_FOUND')
  })

  it('deleteTemplate NOT_FOUND (not FORBIDDEN) for a user in another org — does not leak existence', async () => {
    await expect(
      deleteTemplate(tplAId, { id: userB, orgId: orgB, orgRole: 'owner' }),
    ).rejects.toThrow('NOT_FOUND')
    expect(await prisma.template.findUnique({ where: { id: tplAId } })).not.toBeNull()
  })

  it("listTemplates for org B does not include org A's template", async () => {
    const rows = await listTemplates({ id: userB, orgId: orgB, orgRole: 'owner' })
    expect(rows.map((t) => t.id)).not.toContain(tplAId)
  })
})

// Route-level auth + org-gating, mirroring the document-route RBAC tests.
describe('template routes', () => {
  afterAll(() => { authMock.session = null })

  it('POST /api/templates 401s when unauthenticated', async () => {
    authMock.session = null
    const { POST } = await import('../../src/app/api/templates/route')
    const req = new Request('http://localhost/api/templates', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ documentId: 'x', name: 'y' }),
    })
    const res = await POST(req as unknown as Parameters<typeof POST>[0])
    expect(res.status).toBe(401)
  })

  it('POST /api/templates 201s and saves for the doc owner', async () => {
    const src = await buildSourceDoc('route-save.pdf')
    authMock.session = { user: { id: ownerId, role: 'user', orgId, orgRole: 'member' } }
    const { POST } = await import('../../src/app/api/templates/route')
    const req = new Request('http://localhost/api/templates', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ documentId: src.id, name: 'RouteTpl' }),
    })
    const res = await POST(req as unknown as Parameters<typeof POST>[0])
    expect(res.status).toBe(201)
    const body = await res.json()
    templateIds.push(body.id)
    expect(body.name).toBe('RouteTpl')
  })

  it('POST /api/templates/[id]/use 404s for a template in another org', async () => {
    const src = await buildSourceDoc('route-use.pdf')
    const tpl = await saveAsTemplate(src.id, 'UseMe', null, actor(ownerId, 'member'))
    templateIds.push(tpl.id)

    // A stranger org owner.
    const ob = await prisma.organization.create({ data: { name: 'Route Org B', slug: 'routeb-' + Date.now() } })
    orgIds.push(ob.id)
    const ub = await prisma.user.create({ data: { email: 'routeb' + Date.now() + '@x.com', name: 'B', passwordHash: 'x', role: 'user' } })
    userIds.push(ub.id)
    await prisma.membership.create({ data: { orgId: ob.id, userId: ub.id, role: 'owner' } })

    authMock.session = { user: { id: ub.id, role: 'user', orgId: ob.id, orgRole: 'owner' } }
    const { POST } = await import('../../src/app/api/templates/[id]/use/route')
    const req = new Request(`http://localhost/api/templates/${tpl.id}/use`, { method: 'POST' })
    const res = await POST(req as unknown as Parameters<typeof POST>[0], { params: Promise.resolve({ id: tpl.id }) })
    expect(res.status).toBe(404)
  })

  it('DELETE /api/templates/[id] 403s a non-creator member and 200s the creator', async () => {
    const src = await buildSourceDoc('route-del.pdf')
    const tpl = await saveAsTemplate(src.id, 'DelMe', null, actor(ownerId, 'member'))
    templateIds.push(tpl.id)
    const { DELETE } = await import('../../src/app/api/templates/[id]/route')

    // Non-creator plain member → 403.
    authMock.session = { user: { id: memberId, role: 'user', orgId, orgRole: 'member' } }
    let req = new Request(`http://localhost/api/templates/${tpl.id}`, { method: 'DELETE' })
    let res = await DELETE(req as unknown as Parameters<typeof DELETE>[0], { params: Promise.resolve({ id: tpl.id }) })
    expect(res.status).toBe(403)

    // Creator → 200.
    authMock.session = { user: { id: ownerId, role: 'user', orgId, orgRole: 'member' } }
    req = new Request(`http://localhost/api/templates/${tpl.id}`, { method: 'DELETE' })
    res = await DELETE(req as unknown as Parameters<typeof DELETE>[0], { params: Promise.resolve({ id: tpl.id }) })
    expect(res.status).toBe(200)
    expect(await prisma.template.findUnique({ where: { id: tpl.id } })).toBeNull()
  })
})
