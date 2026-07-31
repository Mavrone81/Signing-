// @vitest-environment node
//
// Must run in the plain Node environment, not jsdom (the project default).
// jsdom's vm-sandboxed realm gives `Buffer` instances that fail
// `instanceof Uint8Array` checks against jsdom's own TypedArray globals,
// which breaks pdf-lib's `PDFDocument.load` (see test/unit/flatten.test.ts
// for the same cross-realm quirk). This suite also hits a real Postgres +
// the filesystem, so `node` is more representative of its actual runtime
// anyway.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
process.env.DATA_KEY ||= '0'.repeat(64); process.env.STORAGE_DIR='/tmp/ds-int-'+Date.now()

// Mutable mock session, read by the mocked `@/auth` module below. vi.hoisted
// guarantees this object exists before the vi.mock factory (which is
// hoisted above all imports) runs.
const authMock = vi.hoisted(() => ({
  session: null as
    | null
    | {
        user: {
          id: string
          role: 'admin' | 'user'
          orgId: string | null
          orgRole: 'owner' | 'admin' | 'member' | null
          // Phase 1b: present on the real session; optional in the mock so the
          // existing document-flow tests (which don't exercise it) stay valid.
          isPlatformAdmin?: boolean
        }
      },
}))
vi.mock('@/auth', () => ({ auth: () => Promise.resolve(authMock.session) }))

import { PDFDocument } from 'pdf-lib'
import { createDocument, saveFields, finalize, resetToDraft, saveRecipients, sendForSignature, finalizeSentDocument, deleteDocument } from '../../src/server/documents/actions'
import { canAccessDocument } from '../../src/lib/rbac'
import { prisma } from '../../src/lib/db'
import { getObject, deleteObject } from '../../src/lib/storage'
import { env } from '../../src/env'
import { flattenPdf } from '../../src/server/pdf/flatten'
import { sha256hex } from '../../src/lib/hash'

let uid: string
let orgId: string
const documentIds: string[] = []
const userIds: string[] = []
const orgIds: string[] = []

beforeAll(async () => {
  // Every test user/document lives in this org; `uid` is a plain member of it.
  const org = await prisma.organization.create({ data: { name: 'Test Org', slug: 'test-' + Date.now() } })
  orgId = org.id
  orgIds.push(org.id)

  const u = await prisma.user.create({ data: { email: 't' + Date.now() + '@x.com', name: 'T', passwordHash: 'x', role: 'user' } })
  uid = u.id
  userIds.push(u.id)
  await prisma.membership.create({ data: { orgId, userId: uid, role: 'member' } })
})

afterAll(async () => {
  // Documents FK org/user with onDelete RESTRICT, so delete docs first; user
  // deletes cascade their memberships, then the orgs can be removed.
  if (documentIds.length) await prisma.document.deleteMany({ where: { id: { in: documentIds } } })
  if (userIds.length) await prisma.user.deleteMany({ where: { id: { in: userIds } } })
  if (orgIds.length) await prisma.organization.deleteMany({ where: { id: { in: orgIds } } })
})

describe('createDocument', () => {
  it('rejects non-pdf', async () => { await expect(createDocument(uid, orgId,'a.pdf',Buffer.from('nope'))).rejects.toThrow('INVALID_PDF') })
  it('stores a valid pdf with page count', async () => {
    const d=await PDFDocument.create(); d.addPage(); d.addPage(); const bytes=Buffer.from(await d.save())
    const res=await createDocument(uid, orgId,'two.pdf',bytes)
    documentIds.push(res.id)
    expect(res.pageCount).toBe(2)
    const doc=await prisma.document.findUnique({where:{id:res.id}})
    expect(doc?.status).toBe('draft'); expect(doc?.originalSha256).toHaveLength(64)

    // owner + audit event
    expect(doc?.ownerId).toBe(uid)
    const events = await prisma.auditEvent.findMany({ where: { documentId: res.id } })
    expect(events).toHaveLength(1)
    expect(events[0].action).toBe('upload')
    expect(events[0].userId).toBe(uid)

    // encrypted blob is actually stored and round-trips to the original bytes
    expect(doc?.originalKey).toBe(`${res.id}/original.pdf`)
    const stored = await getObject(doc!.originalKey)
    expect(Buffer.compare(stored, bytes)).toBe(0)
  })

  it('rejects non-pdf and creates no row', async () => {
    const before = await prisma.document.count({ where: { ownerId: uid } })
    await expect(createDocument(uid, orgId, 'bad.pdf', Buffer.from('not a pdf at all'))).rejects.toThrow('INVALID_PDF')
    const after = await prisma.document.count({ where: { ownerId: uid } })
    expect(after).toBe(before)
  })

  it('rejects oversized upload and creates no row', async () => {
    const before = await prisma.document.count({ where: { ownerId: uid } })
    const big = Buffer.alloc(env.MAX_UPLOAD_MB * 1024 * 1024 + 1)
    await expect(createDocument(uid, orgId, 'big.pdf', big)).rejects.toThrow('TOO_LARGE')
    const after = await prisma.document.count({ where: { ownerId: uid } })
    expect(after).toBe(before)
  })

  it('rejects a corrupt pdf (magic bytes ok, pdf-lib cannot parse) and creates no row', async () => {
    const before = await prisma.document.count({ where: { ownerId: uid } })
    const corrupt = Buffer.from('%PDF-1.4\nnot really a pdf body')
    await expect(createDocument(uid, orgId, 'corrupt.pdf', corrupt)).rejects.toThrow('INVALID_PDF')
    const after = await prisma.document.count({ where: { ownerId: uid } })
    expect(after).toBe(before)
  })
})

async function samplePdfBytes(pages = 1): Promise<Buffer> {
  const d = await PDFDocument.create()
  for (let i = 0; i < pages; i++) d.addPage()
  return Buffer.from(await d.save())
}

describe('POST /api/documents', () => {
  afterAll(() => { authMock.session = null })

  it('401s when unauthenticated', async () => {
    authMock.session = null
    const { POST } = await import('../../src/app/api/documents/route')
    const form = new FormData()
    form.append('file', new File([new Uint8Array(await samplePdfBytes())], 'x.pdf', { type: 'application/pdf' }))
    const req = new Request('http://localhost/api/documents', { method: 'POST', body: form })
    const res = await POST(req as unknown as Parameters<typeof POST>[0])
    expect(res.status).toBe(401)
  })

  it('creates a draft Document for the authenticated user', async () => {
    authMock.session = { user: { id: uid, role: 'user', orgId, orgRole: 'member' } }
    const { POST } = await import('../../src/app/api/documents/route')
    const bytes = await samplePdfBytes(3)
    const form = new FormData()
    form.append('file', new File([new Uint8Array(bytes)], 'three.pdf', { type: 'application/pdf' }))
    const req = new Request('http://localhost/api/documents', { method: 'POST', body: form })
    const res = await POST(req as unknown as Parameters<typeof POST>[0])
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.pageCount).toBe(3)
    documentIds.push(body.id)

    const doc = await prisma.document.findUnique({ where: { id: body.id } })
    expect(doc?.ownerId).toBe(uid)
    expect(doc?.status).toBe('draft')
  })

  it('400s + stores nothing for a non-pdf upload', async () => {
    authMock.session = { user: { id: uid, role: 'user', orgId, orgRole: 'member' } }
    const { POST } = await import('../../src/app/api/documents/route')
    const before = await prisma.document.count({ where: { ownerId: uid } })
    const form = new FormData()
    form.append('file', new File([new Uint8Array(Buffer.from('nope'))], 'bad.pdf', { type: 'application/pdf' }))
    const req = new Request('http://localhost/api/documents', { method: 'POST', body: form })
    const res = await POST(req as unknown as Parameters<typeof POST>[0])
    expect(res.status).toBe(400)
    const after = await prisma.document.count({ where: { ownerId: uid } })
    expect(after).toBe(before)
  })

  it('400s on an oversized declared Content-Length before buffering the body, storing nothing', async () => {
    authMock.session = { user: { id: uid, role: 'user', orgId, orgRole: 'member' } }
    const { POST } = await import('../../src/app/api/documents/route')
    const before = await prisma.document.count({ where: { ownerId: uid } })

    // Declared Content-Length alone exceeds the limit; formData() must never
    // be reached, so a call to it fails the test loudly instead of quietly
    // buffering a body that isn't even provided.
    const req = {
      headers: new Headers({
        'content-length': String(env.MAX_UPLOAD_MB * 1024 * 1024 + 1024 * 1024),
      }),
      formData: () => {
        throw new Error('req.formData() must not be called when Content-Length is already oversized')
      },
    }

    const res = await POST(req as unknown as Parameters<typeof POST>[0])
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toBe('TOO_LARGE')

    const after = await prisma.document.count({ where: { ownerId: uid } })
    expect(after).toBe(before)
  })
})

describe('finalize / saveFields / resetToDraft', () => {
  it('finalize produces a signed pdf with +1 page and locks', async () => {
    const d=await PDFDocument.create(); d.addPage([600,800]); const bytes=Buffer.from(await d.save())
    const { id }=await createDocument(uid, orgId,'f.pdf',bytes)
    documentIds.push(id)
    const savedFields=[{page:1,type:'text' as const,x:0.1,y:0.1,w:0.3,h:0.05,value:'Signed'}]
    await saveFields(id,savedFields)

    // pdf-lib's save() stamps a second-precision ModificationDate on every
    // call, so re-running flattenPdf independently below would otherwise
    // legitimately differ from finalize()'s internal flatten whenever the two
    // calls straddle a wall-clock second. Freeze the clock so both flattens
    // see the same "now" and are byte-for-byte reproducible.
    //
    // Fake ONLY `Date` — not setImmediate/setTimeout: pdf-lib's save() (with a
    // StandardFont-styled text field embedded by flatten.ts) yields to a timer
    // during font serialization, which never resolves if those timers are also
    // faked-but-never-advanced (would hang the test). Production uses real
    // timers, so this is purely a test-harness concern.
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    const res=await finalize(id,{id:uid,name:'T',email:'t@x.com',role:'user'},'1.2.3.4')
    expect(res.signedSha256).toHaveLength(64)
    const doc=await prisma.document.findUnique({where:{id}})
    expect(doc?.status).toBe('signed')
    expect(doc?.signedKey).toBe(`${id}/signed.pdf`)
    expect(doc?.signedSha256).toBe(res.signedSha256)
    expect(doc?.signedAt).not.toBeNull()

    // the stored signed pdf has the original page + 1 cert page
    const signed = await getObject(doc!.signedKey!)
    const signedPdf = await PDFDocument.load(signed)
    expect(signedPdf.getPageCount()).toBe(2)

    // signedSha256 is the hash of the flattened-BEFORE-certificate bytes, not
    // the cert-appended (signed.pdf) bytes — locks in the non-circular hash
    // design (the cert page prints signedSha256, so hashing after appending it
    // would fold the hash into its own input).
    const reflattened = await flattenPdf(bytes, savedFields)
    const expectedSha256 = sha256hex(Buffer.from(reflattened))
    vi.useRealTimers()
    expect(res.signedSha256).toBe(expectedSha256)

    // a finalize AuditEvent was recorded with the ip
    const events = await prisma.auditEvent.findMany({ where: { documentId: id, action: 'finalize' } })
    expect(events).toHaveLength(1)
    expect(events[0].ip).toBe('1.2.3.4')

    // second finalize is a 409 (already signed)
    await expect(finalize(id,{id:uid,name:'T',email:'t@x.com',role:'user'},null)).rejects.toThrow(/409|already/)
  })

  it('persists a text field style and finalize produces a signed pdf', async () => {
    const d=await PDFDocument.create(); d.addPage([600,800]); const bytes=Buffer.from(await d.save())
    const { id }=await createDocument(uid, orgId,'styled.pdf',bytes)
    documentIds.push(id)
    await saveFields(id,[{
      page:1,type:'text' as const,x:0.1,y:0.1,w:0.3,h:0.05,value:'Styled',
      style:{ fontFamily:'Arial', fontSize:16, color:'#0055aa', highlight:'#ffee00', bold:true, italic:false, underline:true },
    }])
    const rows = await prisma.field.findMany({ where: { documentId: id } })
    expect(rows).toHaveLength(1)
    expect(rows[0].style).toMatchObject({ fontFamily:'Arial', fontSize:16, color:'#0055aa', highlight:'#ffee00', bold:true, underline:true })

    await finalize(id,{id:uid,name:'T',email:'t@x.com',role:'user'},null)
    const doc=await prisma.document.findUnique({where:{id}})
    expect(doc?.status).toBe('signed')
    const signed = await getObject(doc!.signedKey!)
    expect((await PDFDocument.load(signed)).getPageCount()).toBe(2)
  })

  it('coerces a bad/partial text style to defaults rather than throwing, and stores null for non-text', async () => {
    const d=await PDFDocument.create(); d.addPage([600,800]); const bytes=Buffer.from(await d.save())
    const { id }=await createDocument(uid, orgId,'coerce.pdf',bytes)
    documentIds.push(id)
    await saveFields(id,[
      // garbage style: bad size, bad hex, non-boolean — all fall back to defaults
      { page:1,type:'text' as const,x:0.1,y:0.1,w:0.3,h:0.05,value:'A',
        style:{ fontFamily:'', fontSize:9999, color:'notahex', highlight:'nope', bold:'yes', italic:1, underline:null } as unknown as never },
      // a signature field must not carry a style
      { page:1,type:'signature' as const,x:0.5,y:0.5,w:0.2,h:0.08,value:'' },
    ])
    const rows = await prisma.field.findMany({ where: { documentId: id }, orderBy: { type: 'asc' } })
    const text = rows.find((r) => r.type === 'text')!
    const sig = rows.find((r) => r.type === 'signature')!
    expect(text.style).toMatchObject({ fontFamily:'Times New Roman', fontSize:96, color:'#111827', highlight:null, bold:false, italic:false, underline:false })
    expect(sig.style).toBeNull()
  })

  it('saveFields refuses to overwrite a signed (locked) document', async () => {
    const d=await PDFDocument.create(); d.addPage([600,800]); const bytes=Buffer.from(await d.save())
    const { id }=await createDocument(uid, orgId,'locked.pdf',bytes)
    documentIds.push(id)
    await saveFields(id,[{page:1,type:'text',x:0.1,y:0.1,w:0.3,h:0.05,value:'Signed'}])
    await finalize(id,{id:uid,name:'T',email:'t@x.com',role:'user'},null)

    const before = await prisma.field.findMany({ where: { documentId: id } })
    await expect(saveFields(id,[{page:1,type:'text',x:0.9,y:0.9,w:0.05,h:0.05,value:'HACKED'}])).rejects.toThrow(/409|ALREADY_SIGNED/)
    const after = await prisma.field.findMany({ where: { documentId: id } })
    expect(after).toEqual(before)
  })

  it('saveFields rejects a non-string value with INVALID_FIELDS', async () => {
    const d=await PDFDocument.create(); d.addPage([600,800]); const bytes=Buffer.from(await d.save())
    const { id }=await createDocument(uid, orgId,'badvalue.pdf',bytes)
    documentIds.push(id)
    await expect(saveFields(id,[{page:1,type:'text',x:0.1,y:0.1,w:0.3,h:0.05,value:123 as unknown as string}])).rejects.toThrow('INVALID_FIELDS')
    const fields = await prisma.field.findMany({ where: { documentId: id } })
    expect(fields).toHaveLength(0)
  })

  // ---- Phase 4a: new field types + required/optional ----

  it('persists checkbox/initials/radio/dropdown with required flag + options', async () => {
    const d=await PDFDocument.create(); d.addPage([600,800]); const bytes=Buffer.from(await d.save())
    const { id }=await createDocument(uid, orgId,'types.pdf',bytes)
    documentIds.push(id)
    await saveFields(id,[
      { page:1,type:'checkbox' as const,x:0.1,y:0.1,w:0.04,h:0.03,value:'true' },
      { page:1,type:'initials' as const,x:0.2,y:0.2,w:0.12,h:0.06,value:'',required:false },
      { page:1,type:'radio' as const,x:0.3,y:0.3,w:0.04,h:0.03,value:'A',options:{group:'g1',label:'A'} },
      { page:1,type:'dropdown' as const,x:0.4,y:0.4,w:0.2,h:0.05,value:'X',options:{choices:['X','Y']} },
    ])
    const rows = await prisma.field.findMany({ where: { documentId: id }, orderBy: { type: 'asc' } })
    const byType = Object.fromEntries(rows.map((r) => [r.type, r]))
    expect(byType.checkbox.required).toBe(true)         // default
    expect(byType.checkbox.value).toBe('true')
    expect(byType.initials.required).toBe(false)        // explicit optional
    expect(byType.radio.options).toMatchObject({ group:'g1', label:'A' })
    expect(byType.dropdown.options).toMatchObject({ choices:['X','Y'] })
    // non-option types store SQL NULL for options
    expect(byType.checkbox.options).toBeNull()
    expect(byType.initials.options).toBeNull()
  })

  it('finalize does NOT block on an OPTIONAL empty field, but DOES block a REQUIRED empty one', async () => {
    // Optional empty text + a filled required checkbox → finalize succeeds.
    const d1=await PDFDocument.create(); d1.addPage([600,800]); const b1=Buffer.from(await d1.save())
    const { id: okId }=await createDocument(uid, orgId,'opt.pdf',b1)
    documentIds.push(okId)
    await saveFields(okId,[
      { page:1,type:'text' as const,x:0.1,y:0.1,w:0.3,h:0.05,value:'',required:false },
      { page:1,type:'checkbox' as const,x:0.5,y:0.5,w:0.04,h:0.03,value:'true',required:true },
    ])
    await expect(finalize(okId,{id:uid,name:'T',email:'t@x.com',role:'user'},null)).resolves.toBeTruthy()

    // A required empty checkbox ('false') → finalize throws INCOMPLETE_FIELDS.
    const d2=await PDFDocument.create(); d2.addPage([600,800]); const b2=Buffer.from(await d2.save())
    const { id: badId }=await createDocument(uid, orgId,'req.pdf',b2)
    documentIds.push(badId)
    await saveFields(badId,[{ page:1,type:'checkbox' as const,x:0.1,y:0.1,w:0.04,h:0.03,value:'false',required:true }])
    await expect(finalize(badId,{id:uid,name:'T',email:'t@x.com',role:'user'},null)).rejects.toThrow('INCOMPLETE_FIELDS')
    const doc=await prisma.document.findUnique({where:{id:badId}})
    expect(doc?.status).toBe('draft') // still a draft — not signed
  })

  it('resetToDraft records the acting user, not the document owner, on the AuditEvent', async () => {
    const admin = await prisma.user.create({ data: { email: 'admin'+Date.now()+'@x.com', name: 'Admin', passwordHash: 'x', role: 'admin' } })
    userIds.push(admin.id)
    const d=await PDFDocument.create(); d.addPage([600,800]); const bytes=Buffer.from(await d.save())
    const { id }=await createDocument(uid, orgId,'actor.pdf',bytes) // owned by uid
    documentIds.push(id)
    await saveFields(id,[{page:1,type:'text',x:0.1,y:0.1,w:0.3,h:0.05,value:'Signed'}])
    await finalize(id,{id:uid,name:'T',email:'t@x.com',role:'user'},null)

    // admin.id (the actor) resets a document it does not own (uid is the owner)
    await resetToDraft(id, admin.id)
    const events = await prisma.auditEvent.findMany({ where: { documentId: id, action: 'reset' } })
    expect(events).toHaveLength(1)
    expect(events[0].userId).toBe(admin.id)
    expect(events[0].userId).not.toBe(uid)
  })

  it('resetToDraft after finalize flips status back to draft and nulls signed fields', async () => {
    const d=await PDFDocument.create(); d.addPage([600,800]); const bytes=Buffer.from(await d.save())
    const { id }=await createDocument(uid, orgId,'r.pdf',bytes)
    documentIds.push(id)
    await saveFields(id,[{page:1,type:'text',x:0.1,y:0.1,w:0.3,h:0.05,value:'Signed'}])
    await finalize(id,{id:uid,name:'T',email:'t@x.com',role:'user'},'1.2.3.4')
    await resetToDraft(id, uid)
    const doc=await prisma.document.findUnique({where:{id}})
    expect(doc?.status).toBe('draft')
    expect(doc?.signedKey).toBeNull()
    expect(doc?.signedSha256).toBeNull()
    expect(doc?.signedAt).toBeNull()
    const events = await prisma.auditEvent.findMany({ where: { documentId: id, action: 'reset' } })
    expect(events).toHaveLength(1)
    expect(events[0].userId).toBe(uid)
    // after reset, finalize works again
    await expect(finalize(id,{id:uid,name:'T',email:'t@x.com',role:'user'},null)).resolves.toBeTruthy()
  })

  it('saveFields rejects an out-of-range coord with INVALID_FIELDS', async () => {
    const d=await PDFDocument.create(); d.addPage([600,800]); const bytes=Buffer.from(await d.save())
    const { id }=await createDocument(uid, orgId,'oob.pdf',bytes)
    documentIds.push(id)
    await expect(saveFields(id,[{page:1,type:'text',x:1.5,y:0.1,w:0.3,h:0.05,value:'x'}])).rejects.toThrow('INVALID_FIELDS')
    // page out of range too
    await expect(saveFields(id,[{page:2,type:'text',x:0.1,y:0.1,w:0.3,h:0.05,value:'x'}])).rejects.toThrow('INVALID_FIELDS')
    // no rows were persisted
    const fields = await prisma.field.findMany({ where: { documentId: id } })
    expect(fields).toHaveLength(0)
  })
})

describe('POST /recipients/[recipientId]/remind — best-effort (email off)', () => {
  afterAll(() => { authMock.session = null })

  it('200 { sent:false, reason:not_configured } for a pending recipient when email is off', async () => {
    const { id } = await createDocument(uid, orgId, 'remind.pdf', await samplePdfBytes())
    documentIds.push(id)
    const [rec] = await saveRecipients(id, [{ name: 'Pat', email: 'pat@x.com', orderIndex: 0 }])
    await saveFields(id, [{ page: 1, type: 'signature', x: 0.1, y: 0.1, w: 0.2, h: 0.05, value: '', recipientId: rec.id }])
    await sendForSignature(id, uid)

    authMock.session = { user: { id: uid, role: 'user', orgId, orgRole: 'member' } }
    const { POST } = await import('../../src/app/api/documents/[id]/recipients/[recipientId]/remind/route')
    const req = new Request(`http://localhost/api/documents/${id}/recipients/${rec.id}/remind`, { method: 'POST' })
    const res = await POST(
      req as unknown as Parameters<typeof POST>[0],
      { params: Promise.resolve({ id, recipientId: rec.id }) },
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ sent: false, reason: 'not_configured' })
  })
})

describe('route-level RBAC (fields / finalize / reset)', () => {
  let strangerUid: string
  let docId: string

  beforeAll(async () => {
    const stranger = await prisma.user.create({ data: { email: 'stranger' + Date.now() + '@x.com', name: 'Stranger', passwordHash: 'x', role: 'user' } })
    strangerUid = stranger.id
    userIds.push(stranger.id)

    const { id } = await createDocument(uid, orgId, 'rbac.pdf', await samplePdfBytes())
    docId = id
    documentIds.push(id)
  })

  afterAll(() => { authMock.session = null })

  it('PUT /fields 403s a non-owner, non-admin user', async () => {
    authMock.session = { user: { id: strangerUid, role: 'user', orgId, orgRole: 'member' } }
    const { PUT } = await import('../../src/app/api/documents/[id]/fields/route')
    const req = new Request(`http://localhost/api/documents/${docId}/fields`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fields: [{ page: 1, type: 'text', x: 0.1, y: 0.1, w: 0.3, h: 0.05, value: 'x' }] }),
    })
    const res = await PUT(
      req as unknown as Parameters<typeof PUT>[0],
      { params: Promise.resolve({ id: docId }) },
    )
    expect(res.status).toBe(403)

    // the document's fields were not touched by the forbidden request
    const fields = await prisma.field.findMany({ where: { documentId: docId } })
    expect(fields).toHaveLength(0)
  })

  it('PUT /fields 401s when unauthenticated', async () => {
    authMock.session = null
    const { PUT } = await import('../../src/app/api/documents/[id]/fields/route')
    const req = new Request(`http://localhost/api/documents/${docId}/fields`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fields: [] }),
    })
    const res = await PUT(
      req as unknown as Parameters<typeof PUT>[0],
      { params: Promise.resolve({ id: docId }) },
    )
    expect(res.status).toBe(401)
  })

  it('POST /finalize 403s a non-owner, non-admin user', async () => {
    authMock.session = { user: { id: strangerUid, role: 'user', orgId, orgRole: 'member' } }
    const { POST } = await import('../../src/app/api/documents/[id]/finalize/route')
    const req = new Request(`http://localhost/api/documents/${docId}/finalize`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fields: [] }),
    })
    const res = await POST(
      req as unknown as Parameters<typeof POST>[0],
      { params: Promise.resolve({ id: docId }) },
    )
    expect(res.status).toBe(403)

    // the document was not signed by the forbidden request
    const doc = await prisma.document.findUnique({ where: { id: docId } })
    expect(doc?.status).toBe('draft')
  })

  it('POST /finalize 404s a missing document', async () => {
    authMock.session = { user: { id: uid, role: 'user', orgId, orgRole: 'member' } }
    const { POST } = await import('../../src/app/api/documents/[id]/finalize/route')
    const req = new Request(`http://localhost/api/documents/does-not-exist/finalize`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fields: [] }),
    })
    const res = await POST(
      req as unknown as Parameters<typeof POST>[0],
      { params: Promise.resolve({ id: 'does-not-exist' }) },
    )
    expect(res.status).toBe(404)
  })
})

describe('GET /api/documents/[id]/file/[kind]', () => {
  afterAll(() => { authMock.session = null })

  it('401s when unauthenticated', async () => {
    authMock.session = null
    const { GET } = await import('../../src/app/api/documents/[id]/file/[kind]/route')
    const req = new Request('http://localhost/api/documents/x/file/original')
    const res = await GET(
      req as unknown as Parameters<typeof GET>[0],
      { params: Promise.resolve({ id: 'x', kind: 'original' }) },
    )
    expect(res.status).toBe(401)
  })

  it('404s an unknown kind', async () => {
    const { id } = await createDocument(uid, orgId, 'kind.pdf', await samplePdfBytes())
    documentIds.push(id)
    authMock.session = { user: { id: uid, role: 'user', orgId, orgRole: 'member' } }
    const { GET } = await import('../../src/app/api/documents/[id]/file/[kind]/route')
    const req = new Request(`http://localhost/api/documents/${id}/file/bogus`)
    const res = await GET(
      req as unknown as Parameters<typeof GET>[0],
      { params: Promise.resolve({ id, kind: 'bogus' }) },
    )
    expect(res.status).toBe(404)
  })

  it('403s a non-owner, non-admin user requesting the original', async () => {
    const stranger = await prisma.user.create({ data: { email: 'dlstranger' + Date.now() + '@x.com', name: 'S', passwordHash: 'x', role: 'user' } })
    userIds.push(stranger.id)
    const { id } = await createDocument(uid, orgId, 'rbac-dl.pdf', await samplePdfBytes())
    documentIds.push(id)

    authMock.session = { user: { id: stranger.id, role: 'user', orgId, orgRole: 'member' } }
    const { GET } = await import('../../src/app/api/documents/[id]/file/[kind]/route')
    const req = new Request(`http://localhost/api/documents/${id}/file/original`)
    const res = await GET(
      req as unknown as Parameters<typeof GET>[0],
      { params: Promise.resolve({ id, kind: 'original' }) },
    )
    expect(res.status).toBe(403)
  })

  it('404s a signed request when the document has never been finalized', async () => {
    const { id } = await createDocument(uid, orgId, 'unsigned.pdf', await samplePdfBytes())
    documentIds.push(id)
    authMock.session = { user: { id: uid, role: 'user', orgId, orgRole: 'member' } }
    const { GET } = await import('../../src/app/api/documents/[id]/file/[kind]/route')
    const req = new Request(`http://localhost/api/documents/${id}/file/signed`)
    const res = await GET(
      req as unknown as Parameters<typeof GET>[0],
      { params: Promise.resolve({ id, kind: 'signed' }) },
    )
    expect(res.status).toBe(404)
  })

  it('original: 200s with a sanitized Content-Disposition filename and does NOT audit a download', async () => {
    const { id } = await createDocument(uid, orgId, '..\\weird "name".pdf', await samplePdfBytes())
    documentIds.push(id)
    authMock.session = { user: { id: uid, role: 'user', orgId, orgRole: 'member' } }
    const { GET } = await import('../../src/app/api/documents/[id]/file/[kind]/route')
    const req = new Request(`http://localhost/api/documents/${id}/file/original`)
    const res = await GET(
      req as unknown as Parameters<typeof GET>[0],
      { params: Promise.resolve({ id, kind: 'original' }) },
    )
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/pdf')
    const disposition = res.headers.get('content-disposition')!
    expect(disposition).toContain('attachment')
    // no raw path separators or quotes leaked into the header value
    expect(disposition).not.toMatch(/["/\\]weird/i)

    const events = await prisma.auditEvent.findMany({ where: { documentId: id, action: 'download' } })
    expect(events).toHaveLength(0)
  })

  it('signed: 200s with a "-signed.pdf" filename and records exactly one download AuditEvent per GET', async () => {
    const bytes = await samplePdfBytes()
    const { id } = await createDocument(uid, orgId, 'contract.pdf', bytes)
    documentIds.push(id)
    await saveFields(id, [{ page: 1, type: 'text', x: 0.1, y: 0.1, w: 0.3, h: 0.05, value: 'Signed' }])
    await finalize(id, { id: uid, name: 'T', email: 't@x.com', role: 'user' }, '9.9.9.9')

    authMock.session = { user: { id: uid, role: 'user', orgId, orgRole: 'member' } }
    const { GET } = await import('../../src/app/api/documents/[id]/file/[kind]/route')

    const req1 = new Request(`http://localhost/api/documents/${id}/file/signed`, {
      headers: { 'user-agent': 'vitest-agent' },
    })
    const res1 = await GET(
      req1 as unknown as Parameters<typeof GET>[0],
      { params: Promise.resolve({ id, kind: 'signed' }) },
    )
    expect(res1.status).toBe(200)
    const disposition = res1.headers.get('content-disposition')!
    expect(disposition).toContain('attachment')
    expect(disposition).toContain('contract-signed.pdf')

    let events = await prisma.auditEvent.findMany({ where: { documentId: id, action: 'download' } })
    expect(events).toHaveLength(1)
    expect(events[0].userId).toBe(uid)
    expect(events[0].userAgent).toBe('vitest-agent')

    // a second download records a second, independent audit event
    const req2 = new Request(`http://localhost/api/documents/${id}/file/signed`)
    await GET(
      req2 as unknown as Parameters<typeof GET>[0],
      { params: Promise.resolve({ id, kind: 'signed' }) },
    )
    events = await prisma.auditEvent.findMany({ where: { documentId: id, action: 'download' } })
    expect(events).toHaveLength(2)
  })
})

describe('GET /api/documents', () => {
  let otherUid: string
  let ownDocId: string
  let otherDocId: string

  beforeAll(async () => {
    const other = await prisma.user.create({ data: { email: 'other' + Date.now() + '@x.com', name: 'Other', passwordHash: 'x', role: 'user' } })
    otherUid = other.id
    userIds.push(other.id)

    const own = await createDocument(uid, orgId, 'own.pdf', await samplePdfBytes())
    ownDocId = own.id
    documentIds.push(own.id)

    const theirs = await createDocument(otherUid, orgId, 'theirs.pdf', await samplePdfBytes())
    otherDocId = theirs.id
    documentIds.push(theirs.id)
  })

  afterAll(() => { authMock.session = null })

  it('401s when unauthenticated', async () => {
    authMock.session = null
    const { GET } = await import('../../src/app/api/documents/route')
    const res = await GET()
    expect(res.status).toBe(401)
  })

  it('a regular user sees only their own documents', async () => {
    authMock.session = { user: { id: uid, role: 'user', orgId, orgRole: 'member' } }
    const { GET } = await import('../../src/app/api/documents/route')
    const res = await GET()
    expect(res.status).toBe(200)
    const body = await res.json()
    const ids: string[] = body.documents.map((d: { id: string }) => d.id)
    expect(ids).toContain(ownDocId)
    expect(ids).not.toContain(otherDocId)
  })

  it('an admin sees all documents', async () => {
    authMock.session = { user: { id: otherUid, role: 'admin', orgId, orgRole: 'admin' } }
    const { GET } = await import('../../src/app/api/documents/route')
    const res = await GET()
    expect(res.status).toBe(200)
    const body = await res.json()
    const ids: string[] = body.documents.map((d: { id: string }) => d.id)
    expect(ids).toContain(ownDocId)
    expect(ids).toContain(otherDocId)
  })
})

// SECURITY: a user in org A must never reach a document in org B — not via the
// pure `canAccessDocument` predicate, and not via any document route — even
// when that user is an OWNER of their own org (org-admin power must not cross
// tenant boundaries).
describe('cross-tenant isolation', () => {
  let userA: string
  let orgA: string
  let userB: string
  let orgB: string
  let docBId: string

  beforeAll(async () => {
    const oa = await prisma.organization.create({ data: { name: 'Org A', slug: 'orga-' + Date.now() } })
    const ob = await prisma.organization.create({ data: { name: 'Org B', slug: 'orgb-' + Date.now() } })
    orgA = oa.id; orgB = ob.id
    orgIds.push(oa.id, ob.id)

    const ua = await prisma.user.create({ data: { email: 'a' + Date.now() + '@x.com', name: 'A', passwordHash: 'x', role: 'user' } })
    const ub = await prisma.user.create({ data: { email: 'b' + Date.now() + '@x.com', name: 'B', passwordHash: 'x', role: 'user' } })
    userA = ua.id; userB = ub.id
    userIds.push(ua.id, ub.id)
    await prisma.membership.create({ data: { orgId: orgA, userId: userA, role: 'owner' } })
    await prisma.membership.create({ data: { orgId: orgB, userId: userB, role: 'owner' } })

    const docB = await createDocument(userB, orgB, 'secret.pdf', await samplePdfBytes())
    docBId = docB.id
    documentIds.push(docB.id)
  })

  afterAll(() => { authMock.session = null })

  it('canAccessDocument is false across orgs, even for an org owner', () => {
    // userA owns org A; the doc belongs to org B → denied purely on org mismatch.
    expect(
      canAccessDocument(
        { id: userA, orgId: orgA, orgRole: 'owner' },
        { ownerId: userB, orgId: orgB },
      ),
    ).toBe(false)
    // sanity: userB (owner of the doc's own org) CAN access it.
    expect(
      canAccessDocument(
        { id: userB, orgId: orgB, orgRole: 'owner' },
        { ownerId: userB, orgId: orgB },
      ),
    ).toBe(true)
  })

  it('GET /file/[kind] 403s a user from another org (owner of their own org)', async () => {
    authMock.session = { user: { id: userA, role: 'user', orgId: orgA, orgRole: 'owner' } }
    const { GET } = await import('../../src/app/api/documents/[id]/file/[kind]/route')
    const req = new Request(`http://localhost/api/documents/${docBId}/file/original`)
    const res = await GET(
      req as unknown as Parameters<typeof GET>[0],
      { params: Promise.resolve({ id: docBId, kind: 'original' }) },
    )
    expect(res.status).toBe(403)
  })
})

// ---------------------------------------------------------------------------
// Phase 4c — status dashboard (server-side filter + search, org-scoped) and the
// downloadable audit-trail report route.
// ---------------------------------------------------------------------------

// Walks the (unrendered) React element tree returned by the page component and
// returns the `documents` prop handed to <DocumentList>.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function findDocumentsProp(node: any, DocumentList: unknown): any[] | null {
  if (!node || typeof node !== 'object') return null
  if (node.type === DocumentList) return node.props?.documents ?? []
  const kids = node.props?.children
  const arr = Array.isArray(kids) ? kids : [kids]
  for (const k of arr) {
    const found = findDocumentsProp(k, DocumentList)
    if (found) return found
  }
  return null
}

describe('Phase 4c — dashboard filter + search (server-side, org-scoped)', () => {
  let dashOrg: string
  let dashUser: string
  let otherOrg: string
  let draftName: string
  let sentName: string
  let contractName: string

  beforeAll(async () => {
    const org = await prisma.organization.create({ data: { name: 'Dash Org', slug: 'dash-' + Date.now() } })
    dashOrg = org.id
    orgIds.push(org.id)
    const ou = await prisma.organization.create({ data: { name: 'Dash Other', slug: 'dasho-' + Date.now() } })
    otherOrg = ou.id
    orgIds.push(ou.id)

    const u = await prisma.user.create({ data: { email: 'dash' + Date.now() + '@x.com', name: 'Dash', passwordHash: 'x', role: 'user' } })
    dashUser = u.id
    userIds.push(u.id)
    await prisma.membership.create({ data: { orgId: dashOrg, userId: dashUser, role: 'owner' } })

    const stamp = Date.now()
    draftName = `Draft-Doc-${stamp}.pdf`
    sentName = `Sent-Doc-${stamp}.pdf`
    contractName = `Contract-AGREEMENT-${stamp}.pdf`

    const d1 = await createDocument(dashUser, dashOrg, draftName, await samplePdfBytes())
    documentIds.push(d1.id)
    const d2 = await createDocument(dashUser, dashOrg, sentName, await samplePdfBytes())
    documentIds.push(d2.id)
    await prisma.document.update({ where: { id: d2.id }, data: { status: 'sent' } })
    const d3 = await createDocument(dashUser, dashOrg, contractName, await samplePdfBytes())
    documentIds.push(d3.id)

    // A document in ANOTHER org — must never appear in dashUser's dashboard.
    const dOther = await createDocument(dashUser, otherOrg, `Foreign-${stamp}.pdf`, await samplePdfBytes())
    documentIds.push(dOther.id)
  })

  afterAll(() => { authMock.session = null })

  async function pageDocs(searchParams: { status?: string; q?: string }) {
    authMock.session = { user: { id: dashUser, role: 'user', orgId: dashOrg, orgRole: 'owner' } }
    const { default: DocumentsPage } = await import('../../src/app/(app)/documents/page')
    const { DocumentList } = await import('../../src/components/documents/DocumentList')
    const el = await DocumentsPage({ searchParams: Promise.resolve(searchParams) })
    return findDocumentsProp(el, DocumentList) ?? []
  }

  it('status filter returns only matching docs, org-scoped', async () => {
    const sent = await pageDocs({ status: 'sent' })
    const names = sent.map((d) => d.originalName)
    expect(names).toContain(sentName)
    expect(names).not.toContain(draftName)
    // never leaks the other org's doc
    expect(names.every((n: string) => !n.startsWith('Foreign-'))).toBe(true)
  })

  it('draft filter excludes the sent doc', async () => {
    const drafts = await pageDocs({ status: 'draft' })
    const names = drafts.map((d) => d.originalName)
    expect(names).toContain(draftName)
    expect(names).toContain(contractName) // still a draft
    expect(names).not.toContain(sentName)
  })

  it('search matches by name (case-insensitive), org-scoped', async () => {
    const hits = await pageDocs({ q: 'agreement' })
    const names = hits.map((d) => d.originalName)
    expect(names).toContain(contractName)
    expect(names).not.toContain(draftName)
    expect(names).not.toContain(sentName)
  })

  it('all filter (no params) lists this org’s docs but never another org’s', async () => {
    const all = await pageDocs({})
    const names = all.map((d) => d.originalName)
    expect(names).toContain(draftName)
    expect(names).toContain(sentName)
    expect(names).toContain(contractName)
    expect(names.every((n: string) => !n.startsWith('Foreign-'))).toBe(true)
  })
})

describe('Phase 4c — audit-trail report route', () => {
  it('200s a valid PDF (>0 pages) for an accessible document', async () => {
    const { id } = await createDocument(uid, orgId, 'audit.pdf', await samplePdfBytes())
    documentIds.push(id)
    authMock.session = { user: { id: uid, role: 'user', orgId, orgRole: 'member' } }
    const { GET } = await import('../../src/app/api/documents/[id]/audit/route')
    const res = await GET(
      new Request(`http://localhost/api/documents/${id}/audit`) as unknown as Parameters<typeof GET>[0],
      { params: Promise.resolve({ id }) },
    )
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/pdf')
    expect(res.headers.get('content-disposition')).toContain('audit-trail.pdf')
    const buf = Buffer.from(await res.arrayBuffer())
    expect(buf.subarray(0, 5).toString('latin1')).toBe('%PDF-')
    const pdf = await PDFDocument.load(buf)
    expect(pdf.getPageCount()).toBeGreaterThan(0)
    authMock.session = null
  })

  it('401s when unauthenticated', async () => {
    authMock.session = null
    const { GET } = await import('../../src/app/api/documents/[id]/audit/route')
    const res = await GET(
      new Request('http://localhost/api/documents/x/audit') as unknown as Parameters<typeof GET>[0],
      { params: Promise.resolve({ id: 'x' }) },
    )
    expect(res.status).toBe(401)
  })

  it('403s a user from another org (cross-tenant isolation)', async () => {
    const oa = await prisma.organization.create({ data: { name: 'Audit A', slug: 'auda-' + Date.now() } })
    const ob = await prisma.organization.create({ data: { name: 'Audit B', slug: 'audb-' + Date.now() } })
    orgIds.push(oa.id, ob.id)
    const ua = await prisma.user.create({ data: { email: 'auda' + Date.now() + '@x.com', name: 'A', passwordHash: 'x', role: 'user' } })
    const ub = await prisma.user.create({ data: { email: 'audb' + Date.now() + '@x.com', name: 'B', passwordHash: 'x', role: 'user' } })
    userIds.push(ua.id, ub.id)
    await prisma.membership.create({ data: { orgId: oa.id, userId: ua.id, role: 'owner' } })
    await prisma.membership.create({ data: { orgId: ob.id, userId: ub.id, role: 'owner' } })
    const docB = await createDocument(ub.id, ob.id, 'audit-secret.pdf', await samplePdfBytes())
    documentIds.push(docB.id)

    authMock.session = { user: { id: ua.id, role: 'user', orgId: oa.id, orgRole: 'owner' } }
    const { GET } = await import('../../src/app/api/documents/[id]/audit/route')
    const res = await GET(
      new Request(`http://localhost/api/documents/${docB.id}/audit`) as unknown as Parameters<typeof GET>[0],
      { params: Promise.resolve({ id: docB.id }) },
    )
    expect(res.status).toBe(403)
    authMock.session = null
  })
})

// ---------------------------------------------------------------------------
// Phase 2a — send-for-signature (sender side): recipients, field assignment,
// send validation, and org-gating on the new routes.
// ---------------------------------------------------------------------------
describe('saveRecipients + field assignment', () => {
  it('persists recipients (replace-all) and mints a unique token per recipient', async () => {
    const { id } = await createDocument(uid, orgId, 'recips.pdf', await samplePdfBytes())
    documentIds.push(id)
    const saved = await saveRecipients(id, [
      { id: 'rcp_a_' + Date.now(), name: 'Alice', email: 'alice@x.com' },
      { name: 'Bob', email: 'bob@x.com', orderIndex: 1 },
    ])
    expect(saved).toHaveLength(2)
    expect(new Set(saved.map((r) => r.token)).size).toBe(2)

    const rows = await prisma.recipient.findMany({ where: { documentId: id }, orderBy: { orderIndex: 'asc' } })
    expect(rows.map((r) => r.email)).toEqual(['alice@x.com', 'bob@x.com'])
    expect(rows.every((r) => r.status === 'pending' && r.token.length > 0)).toBe(true)

    // replace-all: saving a shorter list removes the extra recipient
    await saveRecipients(id, [{ name: 'Carol', email: 'carol@x.com' }])
    const after = await prisma.recipient.findMany({ where: { documentId: id } })
    expect(after).toHaveLength(1)
    expect(after[0].email).toBe('carol@x.com')
  })

  it('rejects a malformed email with INVALID_RECIPIENTS and persists nothing', async () => {
    const { id } = await createDocument(uid, orgId, 'bademail.pdf', await samplePdfBytes())
    documentIds.push(id)
    await expect(saveRecipients(id, [{ name: 'X', email: 'not-an-email' }])).rejects.toThrow('INVALID_RECIPIENTS')
    expect(await prisma.recipient.count({ where: { documentId: id } })).toBe(0)
  })

  it('persists field.recipientId when a field is assigned to a saved recipient', async () => {
    const { id } = await createDocument(uid, orgId, 'assign.pdf', await samplePdfBytes())
    documentIds.push(id)
    const [alice] = await saveRecipients(id, [{ name: 'Alice', email: 'alice2@x.com' }])
    await saveFields(id, [
      { page: 1, type: 'signature', x: 0.1, y: 0.1, w: 0.2, h: 0.08, value: '', recipientId: alice.id },
      { page: 1, type: 'text', x: 0.5, y: 0.5, w: 0.2, h: 0.05, value: 'self' }, // recipientId omitted → null
    ])
    const rows = await prisma.field.findMany({ where: { documentId: id }, orderBy: { type: 'asc' } })
    const sig = rows.find((r) => r.type === 'signature')!
    const txt = rows.find((r) => r.type === 'text')!
    expect(sig.recipientId).toBe(alice.id)
    expect(txt.recipientId).toBeNull()
  })

  it('rejects a field whose recipientId is not a recipient of the document (INVALID_FIELDS)', async () => {
    const { id } = await createDocument(uid, orgId, 'badassign.pdf', await samplePdfBytes())
    documentIds.push(id)
    await saveRecipients(id, [{ name: 'Alice', email: 'alice3@x.com' }])
    await expect(
      saveFields(id, [{ page: 1, type: 'text', x: 0.1, y: 0.1, w: 0.2, h: 0.05, value: 'x', recipientId: 'not-a-real-recipient' }]),
    ).rejects.toThrow('INVALID_FIELDS')
  })
})

describe('sendForSignature', () => {
  it('rejects a document with zero recipients (NO_RECIPIENTS)', async () => {
    const { id } = await createDocument(uid, orgId, 'norcp.pdf', await samplePdfBytes())
    documentIds.push(id)
    await expect(sendForSignature(id, uid)).rejects.toThrow('NO_RECIPIENTS')
    const doc = await prisma.document.findUnique({ where: { id } })
    expect(doc?.status).toBe('draft')
  })

  it('rejects when a recipient has no assigned field (RECIPIENT_WITHOUT_FIELD)', async () => {
    const { id } = await createDocument(uid, orgId, 'orphan.pdf', await samplePdfBytes())
    documentIds.push(id)
    const [alice, bob] = await saveRecipients(id, [
      { name: 'Alice', email: 'a4@x.com' },
      { name: 'Bob', email: 'b4@x.com' },
    ])
    // only Alice gets a field; Bob has none
    await saveFields(id, [{ page: 1, type: 'signature', x: 0.1, y: 0.1, w: 0.2, h: 0.08, value: '', recipientId: alice.id }])
    void bob
    await expect(sendForSignature(id, uid)).rejects.toThrow('RECIPIENT_WITHOUT_FIELD')
    expect((await prisma.document.findUnique({ where: { id } }))?.status).toBe('draft')
  })

  it('sends: flips to sent, stamps sentAt, mints fresh tokens, and audits the send', async () => {
    const { id } = await createDocument(uid, orgId, 'send.pdf', await samplePdfBytes())
    documentIds.push(id)
    const [alice, bob] = await saveRecipients(id, [
      { name: 'Alice', email: 'a5@x.com' },
      { name: 'Bob', email: 'b5@x.com' },
    ])
    const preTokens = new Set([alice.token, bob.token])
    await saveFields(id, [
      { page: 1, type: 'signature', x: 0.1, y: 0.1, w: 0.2, h: 0.08, value: '', recipientId: alice.id },
      { page: 1, type: 'signature', x: 0.5, y: 0.5, w: 0.2, h: 0.08, value: '', recipientId: bob.id },
    ])
    const links = await sendForSignature(id, uid, { ip: '1.2.3.4' })
    expect(links).toHaveLength(2)
    // fresh tokens minted at send (differ from the placeholder tokens)
    expect(links.every((l) => !preTokens.has(l.token))).toBe(true)

    const doc = await prisma.document.findUnique({ where: { id } })
    expect(doc?.status).toBe('sent')
    expect(doc?.sentAt).not.toBeNull()

    const recips = await prisma.recipient.findMany({ where: { documentId: id } })
    expect(recips.every((r) => r.status === 'pending')).toBe(true)

    const events = await prisma.auditEvent.findMany({ where: { documentId: id, action: 'send' } })
    expect(events).toHaveLength(1)
    expect(events[0].userId).toBe(uid)

    // a sent document is locked: saveFields / saveRecipients / re-send all refuse
    await expect(saveFields(id, [])).rejects.toThrow(/409|ALREADY_SIGNED/)
    await expect(saveRecipients(id, [{ name: 'C', email: 'c5@x.com' }])).rejects.toThrow(/409|ALREADY_SIGNED/)
    await expect(sendForSignature(id, uid)).rejects.toThrow(/409|ALREADY_SIGNED/)
  })
})

describe('route-level RBAC (recipients / send)', () => {
  let strangerUid: string
  let docId: string

  beforeAll(async () => {
    const stranger = await prisma.user.create({ data: { email: 'p2stranger' + Date.now() + '@x.com', name: 'Stranger', passwordHash: 'x', role: 'user' } })
    strangerUid = stranger.id
    userIds.push(stranger.id)
    const { id } = await createDocument(uid, orgId, 'p2rbac.pdf', await samplePdfBytes())
    docId = id
    documentIds.push(id)
  })

  afterAll(() => { authMock.session = null })

  it('PUT /recipients 401s when unauthenticated', async () => {
    authMock.session = null
    const { PUT } = await import('../../src/app/api/documents/[id]/recipients/route')
    const req = new Request(`http://localhost/api/documents/${docId}/recipients`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ recipients: [] }),
    })
    const res = await PUT(req as unknown as Parameters<typeof PUT>[0], { params: Promise.resolve({ id: docId }) })
    expect(res.status).toBe(401)
  })

  it('PUT /recipients 403s a non-owner, non-admin user', async () => {
    authMock.session = { user: { id: strangerUid, role: 'user', orgId, orgRole: 'member' } }
    const { PUT } = await import('../../src/app/api/documents/[id]/recipients/route')
    const req = new Request(`http://localhost/api/documents/${docId}/recipients`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ recipients: [{ name: 'X', email: 'x@x.com' }] }),
    })
    const res = await PUT(req as unknown as Parameters<typeof PUT>[0], { params: Promise.resolve({ id: docId }) })
    expect(res.status).toBe(403)
    expect(await prisma.recipient.count({ where: { documentId: docId } })).toBe(0)
  })

  it('POST /send 403s a non-owner, non-admin user', async () => {
    authMock.session = { user: { id: strangerUid, role: 'user', orgId, orgRole: 'member' } }
    const { POST } = await import('../../src/app/api/documents/[id]/send/route')
    const req = new Request(`http://localhost/api/documents/${docId}/send`, { method: 'POST' })
    const res = await POST(req as unknown as Parameters<typeof POST>[0], { params: Promise.resolve({ id: docId }) })
    expect(res.status).toBe(403)
  })
})

// Cross-tenant: a user who owns their OWN org must not reach another org's
// document via the new recipients/send routes, and never see its tokens.
describe('cross-tenant isolation (recipients / send)', () => {
  let userA: string
  let orgA: string
  let docBId: string

  beforeAll(async () => {
    const oa = await prisma.organization.create({ data: { name: 'P2 Org A', slug: 'p2orga-' + Date.now() } })
    const ob = await prisma.organization.create({ data: { name: 'P2 Org B', slug: 'p2orgb-' + Date.now() } })
    orgA = oa.id
    orgIds.push(oa.id, ob.id)
    const ua = await prisma.user.create({ data: { email: 'p2a' + Date.now() + '@x.com', name: 'A', passwordHash: 'x', role: 'user' } })
    const ub = await prisma.user.create({ data: { email: 'p2b' + Date.now() + '@x.com', name: 'B', passwordHash: 'x', role: 'user' } })
    userA = ua.id
    userIds.push(ua.id, ub.id)
    await prisma.membership.create({ data: { orgId: orgA, userId: userA, role: 'owner' } })
    await prisma.membership.create({ data: { orgId: ob.id, userId: ub.id, role: 'owner' } })
    const docB = await createDocument(ub.id, ob.id, 'p2secret.pdf', await samplePdfBytes())
    docBId = docB.id
    documentIds.push(docB.id)
  })

  afterAll(() => { authMock.session = null })

  it('PUT /recipients 403s a user from another org (owner of their own org)', async () => {
    authMock.session = { user: { id: userA, role: 'user', orgId: orgA, orgRole: 'owner' } }
    const { PUT } = await import('../../src/app/api/documents/[id]/recipients/route')
    const req = new Request(`http://localhost/api/documents/${docBId}/recipients`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ recipients: [{ name: 'X', email: 'x@x.com' }] }),
    })
    const res = await PUT(req as unknown as Parameters<typeof PUT>[0], { params: Promise.resolve({ id: docBId }) })
    expect(res.status).toBe(403)
  })

  it('POST /send 403s a user from another org (owner of their own org)', async () => {
    authMock.session = { user: { id: userA, role: 'user', orgId: orgA, orgRole: 'owner' } }
    const { POST } = await import('../../src/app/api/documents/[id]/send/route')
    const req = new Request(`http://localhost/api/documents/${docBId}/send`, { method: 'POST' })
    const res = await POST(req as unknown as Parameters<typeof POST>[0], { params: Promise.resolve({ id: docBId }) })
    expect(res.status).toBe(403)
  })

  it('POST /recipients/[recipientId]/remind 403s a user from another org', async () => {
    authMock.session = { user: { id: userA, role: 'user', orgId: orgA, orgRole: 'owner' } }
    const { POST } = await import('../../src/app/api/documents/[id]/recipients/[recipientId]/remind/route')
    const req = new Request(`http://localhost/api/documents/${docBId}/recipients/whatever/remind`, { method: 'POST' })
    const res = await POST(
      req as unknown as Parameters<typeof POST>[0],
      { params: Promise.resolve({ id: docBId, recipientId: 'whatever' }) },
    )
    expect(res.status).toBe(403)
  })

  it('POST /recipients/[recipientId]/remind 401s when unauthenticated', async () => {
    authMock.session = null
    const { POST } = await import('../../src/app/api/documents/[id]/recipients/[recipientId]/remind/route')
    const req = new Request(`http://localhost/api/documents/${docBId}/recipients/whatever/remind`, { method: 'POST' })
    const res = await POST(
      req as unknown as Parameters<typeof POST>[0],
      { params: Promise.resolve({ id: docBId, recipientId: 'whatever' }) },
    )
    expect(res.status).toBe(401)
  })
})

// ---------------------------------------------------------------------------
// Delete-document: removes the Document row (cascading Field/Recipient/
// AuditEvent) + both encrypted blobs, tenant-scoped via canAccessDocument.
// ---------------------------------------------------------------------------
describe('deleteDocument', () => {
  it('owner deletes their own draft doc: row + cascaded fields removed, blob gone', async () => {
    const { id } = await createDocument(uid, orgId, 'del-own.pdf', await samplePdfBytes())
    documentIds.push(id)
    await saveFields(id, [{ page: 1, type: 'text', x: 0.1, y: 0.1, w: 0.3, h: 0.05, value: 'x' }])
    const doc = await prisma.document.findUnique({ where: { id } })
    const originalKey = doc!.originalKey

    await deleteDocument(id, { id: uid, orgId, orgRole: 'member' })

    expect(await prisma.document.findUnique({ where: { id } })).toBeNull()
    expect(await prisma.field.count({ where: { documentId: id } })).toBe(0)
    await expect(getObject(originalKey)).rejects.toThrow()
  })

  it('cascades Recipient rows and removes BOTH blobs for a completed (sent+signed) document', async () => {
    const { id } = await createDocument(uid, orgId, 'del-completed.pdf', await samplePdfBytes())
    documentIds.push(id)
    const [rec] = await saveRecipients(id, [{ name: 'Pat', email: 'delpat@x.com' }])
    await saveFields(id, [{ page: 1, type: 'signature', x: 0.1, y: 0.1, w: 0.2, h: 0.08, value: '', recipientId: rec.id }])
    await sendForSignature(id, uid)
    await finalizeSentDocument(id)

    const doc = await prisma.document.findUnique({ where: { id } })
    expect(doc?.status).toBe('completed')
    const { originalKey, signedKey } = doc!
    expect(signedKey).not.toBeNull()

    await deleteDocument(id, { id: uid, orgId, orgRole: 'member' })

    expect(await prisma.document.findUnique({ where: { id } })).toBeNull()
    expect(await prisma.recipient.count({ where: { documentId: id } })).toBe(0)
    expect(await prisma.field.count({ where: { documentId: id } })).toBe(0)
    await expect(getObject(originalKey)).rejects.toThrow()
    await expect(getObject(signedKey!)).rejects.toThrow()
  })

  it('an org owner/admin may delete another member’s document', async () => {
    const owner = await prisma.user.create({ data: { email: 'delowner' + Date.now() + '@x.com', name: 'Owner', passwordHash: 'x', role: 'user' } })
    userIds.push(owner.id)
    await prisma.membership.create({ data: { orgId, userId: owner.id, role: 'owner' } })

    const { id } = await createDocument(uid, orgId, 'del-by-admin.pdf', await samplePdfBytes())
    documentIds.push(id)

    await deleteDocument(id, { id: owner.id, orgId, orgRole: 'owner' })
    expect(await prisma.document.findUnique({ where: { id } })).toBeNull()
  })

  it('refuses a same-org member deleting another member’s document (NOT_FOUND, doc untouched)', async () => {
    const other = await prisma.user.create({ data: { email: 'delother' + Date.now() + '@x.com', name: 'Other', passwordHash: 'x', role: 'user' } })
    userIds.push(other.id)
    await prisma.membership.create({ data: { orgId, userId: other.id, role: 'member' } })

    const { id } = await createDocument(uid, orgId, 'del-refused-member.pdf', await samplePdfBytes())
    documentIds.push(id)

    await expect(deleteDocument(id, { id: other.id, orgId, orgRole: 'member' })).rejects.toThrow('NOT_FOUND')
    expect(await prisma.document.findUnique({ where: { id } })).not.toBeNull()
  })

  it('refuses a user from a different org, even an owner of their own org (NOT_FOUND, doc untouched)', async () => {
    const foreignOrg = await prisma.organization.create({ data: { name: 'Del Foreign Org', slug: 'del-foreign-' + Date.now() } })
    orgIds.push(foreignOrg.id)
    const foreignUser = await prisma.user.create({ data: { email: 'delforeign' + Date.now() + '@x.com', name: 'Foreign', passwordHash: 'x', role: 'user' } })
    userIds.push(foreignUser.id)
    await prisma.membership.create({ data: { orgId: foreignOrg.id, userId: foreignUser.id, role: 'owner' } })

    const { id } = await createDocument(uid, orgId, 'del-refused-crossorg.pdf', await samplePdfBytes())
    documentIds.push(id)

    await expect(
      deleteDocument(id, { id: foreignUser.id, orgId: foreignOrg.id, orgRole: 'owner' }),
    ).rejects.toThrow('NOT_FOUND')
    expect(await prisma.document.findUnique({ where: { id } })).not.toBeNull()
  })

  it('throws NOT_FOUND for a missing document', async () => {
    await expect(
      deleteDocument('does-not-exist', { id: uid, orgId, orgRole: 'member' }),
    ).rejects.toThrow('NOT_FOUND')
  })

  it('tolerates an already-missing blob (best-effort) and still deletes the row', async () => {
    const { id } = await createDocument(uid, orgId, 'del-missing-blob.pdf', await samplePdfBytes())
    documentIds.push(id)
    const doc = await prisma.document.findUnique({ where: { id } })
    // Simulate the blob having already been removed out-of-band.
    await deleteObject(doc!.originalKey)

    await expect(deleteDocument(id, { id: uid, orgId, orgRole: 'member' })).resolves.toBeUndefined()
    expect(await prisma.document.findUnique({ where: { id } })).toBeNull()
  })
})

describe('DELETE /api/documents/[id]', () => {
  afterAll(() => { authMock.session = null })

  it('401s when unauthenticated', async () => {
    authMock.session = null
    const { DELETE } = await import('../../src/app/api/documents/[id]/route')
    const req = new Request('http://localhost/api/documents/x', { method: 'DELETE' })
    const res = await DELETE(req as unknown as Parameters<typeof DELETE>[0], { params: Promise.resolve({ id: 'x' }) })
    expect(res.status).toBe(401)
  })

  it('404s a missing document', async () => {
    authMock.session = { user: { id: uid, role: 'user', orgId, orgRole: 'member' } }
    const { DELETE } = await import('../../src/app/api/documents/[id]/route')
    const req = new Request('http://localhost/api/documents/does-not-exist', { method: 'DELETE' })
    const res = await DELETE(req as unknown as Parameters<typeof DELETE>[0], { params: Promise.resolve({ id: 'does-not-exist' }) })
    expect(res.status).toBe(404)
  })

  it('404s (never 403) a same-org non-owner, non-admin user deleting another member’s document', async () => {
    const stranger = await prisma.user.create({ data: { email: 'delroutestranger' + Date.now() + '@x.com', name: 'S', passwordHash: 'x', role: 'user' } })
    userIds.push(stranger.id)
    await prisma.membership.create({ data: { orgId, userId: stranger.id, role: 'member' } })
    const { id } = await createDocument(uid, orgId, 'del-route-stranger.pdf', await samplePdfBytes())
    documentIds.push(id)

    authMock.session = { user: { id: stranger.id, role: 'user', orgId, orgRole: 'member' } }
    const { DELETE } = await import('../../src/app/api/documents/[id]/route')
    const req = new Request(`http://localhost/api/documents/${id}`, { method: 'DELETE' })
    const res = await DELETE(req as unknown as Parameters<typeof DELETE>[0], { params: Promise.resolve({ id }) })
    expect(res.status).toBe(404)

    expect(await prisma.document.findUnique({ where: { id } })).not.toBeNull()
  })

  it('404s (never leaking existence) a user from a different org, even an owner of their own org', async () => {
    const foreignOrg = await prisma.organization.create({ data: { name: 'Del Route Foreign Org', slug: 'del-route-foreign-' + Date.now() } })
    orgIds.push(foreignOrg.id)
    const foreignUser = await prisma.user.create({ data: { email: 'delroutef' + Date.now() + '@x.com', name: 'F', passwordHash: 'x', role: 'user' } })
    userIds.push(foreignUser.id)
    await prisma.membership.create({ data: { orgId: foreignOrg.id, userId: foreignUser.id, role: 'owner' } })

    const { id } = await createDocument(uid, orgId, 'del-route-crossorg.pdf', await samplePdfBytes())
    documentIds.push(id)

    authMock.session = { user: { id: foreignUser.id, role: 'user', orgId: foreignOrg.id, orgRole: 'owner' } }
    const { DELETE } = await import('../../src/app/api/documents/[id]/route')
    const req = new Request(`http://localhost/api/documents/${id}`, { method: 'DELETE' })
    const res = await DELETE(req as unknown as Parameters<typeof DELETE>[0], { params: Promise.resolve({ id }) })
    expect(res.status).toBe(404)

    expect(await prisma.document.findUnique({ where: { id } })).not.toBeNull()
  })

  it('200s and permanently removes the document + blob for its own owner', async () => {
    const { id } = await createDocument(uid, orgId, 'del-route-ok.pdf', await samplePdfBytes())
    documentIds.push(id)
    const doc = await prisma.document.findUnique({ where: { id } })
    const originalKey = doc!.originalKey

    authMock.session = { user: { id: uid, role: 'user', orgId, orgRole: 'member' } }
    const { DELETE } = await import('../../src/app/api/documents/[id]/route')
    const req = new Request(`http://localhost/api/documents/${id}`, { method: 'DELETE' })
    const res = await DELETE(req as unknown as Parameters<typeof DELETE>[0], { params: Promise.resolve({ id }) })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ ok: true })

    expect(await prisma.document.findUnique({ where: { id } })).toBeNull()
    await expect(getObject(originalKey)).rejects.toThrow()
  })

  it('200s for an org admin deleting a document owned by another member', async () => {
    const admin = await prisma.user.create({ data: { email: 'delrouteadmin' + Date.now() + '@x.com', name: 'Admin', passwordHash: 'x', role: 'user' } })
    userIds.push(admin.id)
    await prisma.membership.create({ data: { orgId, userId: admin.id, role: 'admin' } })
    const { id } = await createDocument(uid, orgId, 'del-route-by-admin.pdf', await samplePdfBytes())
    documentIds.push(id)

    authMock.session = { user: { id: admin.id, role: 'user', orgId, orgRole: 'admin' } }
    const { DELETE } = await import('../../src/app/api/documents/[id]/route')
    const req = new Request(`http://localhost/api/documents/${id}`, { method: 'DELETE' })
    const res = await DELETE(req as unknown as Parameters<typeof DELETE>[0], { params: Promise.resolve({ id }) })
    expect(res.status).toBe(200)
    expect(await prisma.document.findUnique({ where: { id } })).toBeNull()
  })
})
