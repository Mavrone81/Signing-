// @vitest-environment node
//
// Phase 2b — recipient signing (`/sign/[token]`). Runs under plain `node`
// (real Postgres + filesystem + pdf-lib) for the same cross-realm reasons as
// documents.test.ts / flatten.test.ts.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
process.env.DATA_KEY ||= '0'.repeat(64)
process.env.STORAGE_DIR = '/tmp/ds-sign-' + Date.now()

import { PDFDocument } from 'pdf-lib'
import {
  createDocument,
  saveFields,
  saveRecipients,
  sendForSignature,
} from '../../src/server/documents/actions'
import {
  viewSigner,
  completeSigning,
  declineSigning,
} from '../../src/server/documents/signing'
import { prisma } from '../../src/lib/db'
import { getObject } from '../../src/lib/storage'

let orgId: string
let uid: string
const documentIds: string[] = []
const userIds: string[] = []
const orgIds: string[] = []

async function samplePdfBytes(pages = 1): Promise<Buffer> {
  const d = await PDFDocument.create()
  for (let i = 0; i < pages; i++) d.addPage([600, 800])
  return Buffer.from(await d.save())
}

async function extractPageText(bytes: Uint8Array, pageNumber: number): Promise<string> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const doc = await pdfjs.getDocument({ data: bytes }).promise
  const page = await doc.getPage(pageNumber)
  const content = await page.getTextContent()
  return content.items.map((item) => ('str' in item ? item.str : '')).join('')
}

// A signature data URL (1x1 png) that passes the data:image gate + flattens.
const PNG_1x1 =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC'

// Build a fresh doc, add recipients, assign one field each, and send it.
// Returns each recipient with its live signing token.
async function makeSent(
  order: 'parallel' | 'sequential',
  people: { name: string; email: string }[],
): Promise<{ id: string; recipients: { id: string; name: string; email: string; token: string }[] }> {
  const { id } = await createDocument(uid, orgId, 'sf.pdf', await samplePdfBytes())
  documentIds.push(id)
  const saved = await saveRecipients(
    id,
    people.map((p, i) => ({ name: p.name, email: p.email, orderIndex: i })),
    { signingOrder: order },
  )
  await saveFields(
    id,
    saved.map((r, i) => ({
      page: 1,
      type: 'signature' as const,
      x: 0.1,
      y: 0.1 + i * 0.1,
      w: 0.2,
      h: 0.08,
      value: '',
      recipientId: r.id,
    })),
  )
  const links = await sendForSignature(id, uid)
  return { id, recipients: links.map((l) => ({ id: l.id, name: l.name, email: l.email, token: l.token })) }
}

beforeAll(async () => {
  const org = await prisma.organization.create({ data: { name: 'Sign Org', slug: 'sign-' + Date.now() } })
  orgId = org.id
  orgIds.push(org.id)
  const u = await prisma.user.create({ data: { email: 'sender' + Date.now() + '@x.com', name: 'Sender', passwordHash: 'x', role: 'user' } })
  uid = u.id
  userIds.push(u.id)
  await prisma.membership.create({ data: { orgId, userId: uid, role: 'member' } })
})

afterAll(async () => {
  if (documentIds.length) await prisma.document.deleteMany({ where: { id: { in: documentIds } } })
  if (userIds.length) await prisma.user.deleteMany({ where: { id: { in: userIds } } })
  if (orgIds.length) await prisma.organization.deleteMany({ where: { id: { in: orgIds } } })
})

describe('token validation', () => {
  it('rejects an unknown token as not_found', async () => {
    const r = await viewSigner('definitely-not-a-real-token')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('not_found')
  })

  it('a token for a NON-sent (draft) document does not grant signing', async () => {
    const { id } = await createDocument(uid, orgId, 'draft.pdf', await samplePdfBytes())
    documentIds.push(id)
    const [alice] = await saveRecipients(id, [{ name: 'Alice', email: 'draft-a@x.com' }])
    // token exists (placeholder) but the doc was never sent → inactive
    const r = await viewSigner(alice.token)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('inactive')
  })

  it('first valid view stamps viewedAt + status viewed', async () => {
    const { recipients } = await makeSent('parallel', [{ name: 'Vic', email: 'vic@x.com' }])
    const r = await viewSigner(recipients[0].token)
    expect(r.ok).toBe(true)
    const row = await prisma.recipient.findUnique({ where: { id: recipients[0].id } })
    expect(row?.status).toBe('viewed')
    expect(row?.viewedAt).not.toBeNull()
  })

  it('a token whose recipient already signed is done_signed', async () => {
    const { recipients } = await makeSent('parallel', [{ name: 'Sol', email: 'sol@x.com' }])
    const done = await completeSigning(recipients[0].token, [{ fieldId: (await myFieldId(recipients[0].id)), value: PNG_1x1 }])
    expect(done.ok).toBe(true)
    const r = await viewSigner(recipients[0].token)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('done_signed')
  })
})

// Helper: the (single) field assigned to a recipient.
async function myFieldId(recipientId: string): Promise<string> {
  const f = await prisma.field.findFirst({ where: { recipientId } })
  return f!.id
}

describe('field scoping', () => {
  it('rejects a value targeting a field NOT owned by this recipient (invalid_values)', async () => {
    const { recipients } = await makeSent('parallel', [
      { name: 'Ann', email: 'ann@x.com' },
      { name: 'Ben', email: 'ben@x.com' },
    ])
    const bensField = await myFieldId(recipients[1].id)
    // Ann tries to set Ben's field → rejected, nothing persisted, Ann not signed.
    const res = await completeSigning(recipients[0].token, [{ fieldId: bensField, value: PNG_1x1 }])
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toBe('invalid_values')
    const ann = await prisma.recipient.findUnique({ where: { id: recipients[0].id } })
    expect(ann?.status).not.toBe('signed')
  })

  it('rejects finishing with a required field left empty', async () => {
    const { recipients } = await makeSent('parallel', [{ name: 'Em', email: 'em@x.com' }])
    const res = await completeSigning(recipients[0].token, [])
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toBe('invalid_values')
  })
})

describe('complete + finalize', () => {
  it('one of two signs → recipient signed, document still sent (not yet completed)', async () => {
    const { id, recipients } = await makeSent('parallel', [
      { name: 'P1', email: 'p1@x.com' },
      { name: 'P2', email: 'p2@x.com' },
    ])
    const res = await completeSigning(recipients[0].token, [{ fieldId: await myFieldId(recipients[0].id), value: PNG_1x1 }], { ip: '5.5.5.5' })
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.completed).toBe(false)
    const doc = await prisma.document.findUnique({ where: { id } })
    expect(doc?.status).toBe('sent')
    // a `sign` audit event with the IP + recipient identity in detail
    const ev = await prisma.auditEvent.findFirst({ where: { documentId: id, action: 'sign' } })
    expect(ev?.ip).toBe('5.5.5.5')
    expect(ev?.userId).toBeNull()
    expect((ev?.detail as { recipientId?: string })?.recipientId).toBe(recipients[0].id)
  })

  it('all recipients sign → document completed + signed PDF has a multi-signer certificate', async () => {
    const { id, recipients } = await makeSent('parallel', [
      { name: 'Dana', email: 'dana@x.com' },
      { name: 'Erin', email: 'erin@x.com' },
    ])
    await completeSigning(recipients[0].token, [{ fieldId: await myFieldId(recipients[0].id), value: PNG_1x1 }], { ip: '1.1.1.1' })
    const last = await completeSigning(recipients[1].token, [{ fieldId: await myFieldId(recipients[1].id), value: PNG_1x1 }], { ip: '2.2.2.2' })
    expect(last.ok).toBe(true)
    if (last.ok) expect(last.completed).toBe(true)

    const doc = await prisma.document.findUnique({ where: { id } })
    expect(doc?.status).toBe('completed')
    expect(doc?.signedKey).toBe(`${id}/signed.pdf`)
    expect(doc?.signedSha256).toHaveLength(64)
    expect(doc?.signedAt).not.toBeNull()

    const signed = await getObject(doc!.signedKey!)
    const signedPdf = await PDFDocument.load(signed)
    // original 1 page + 1 certificate page
    expect(signedPdf.getPageCount()).toBe(2)

    // the certificate lists BOTH signers (name + email + their IP) and both hashes
    const text = await extractPageText(new Uint8Array(signed), 2)
    expect(text).toContain('Dana')
    expect(text).toContain('dana@x.com')
    expect(text).toContain('1.1.1.1')
    expect(text).toContain('Erin')
    expect(text).toContain('erin@x.com')
    expect(text).toContain('2.2.2.2')
    expect(text).toContain(doc!.originalSha256)
    expect(text).toContain(doc!.signedSha256!)

    // a finalize audit event (no user — the recipient triggered it)
    const fin = await prisma.auditEvent.findFirst({ where: { documentId: id, action: 'finalize' } })
    expect(fin?.userId).toBeNull()

    // the finished tokens no longer grant signing
    const r = await viewSigner(recipients[0].token)
    expect(r.ok).toBe(false)
  })
})

describe('decline', () => {
  it('declining flips the recipient + document to declined and blocks the others', async () => {
    const { id, recipients } = await makeSent('parallel', [
      { name: 'Xan', email: 'xan@x.com' },
      { name: 'Ymir', email: 'ymir@x.com' },
    ])
    const res = await declineSigning(recipients[0].token, { ip: '9.9.9.9' })
    expect(res.ok).toBe(true)
    const rec = await prisma.recipient.findUnique({ where: { id: recipients[0].id } })
    expect(rec?.status).toBe('declined')
    expect(rec?.declinedAt).not.toBeNull()
    const doc = await prisma.document.findUnique({ where: { id } })
    expect(doc?.status).toBe('declined')
    // the other recipient can no longer sign (doc is declined → inactive)
    const other = await viewSigner(recipients[1].token)
    expect(other.ok).toBe(false)
    if (!other.ok) expect(other.reason).toBe('inactive')
    const ev = await prisma.auditEvent.findFirst({ where: { documentId: id, action: 'decline' } })
    expect(ev?.ip).toBe('9.9.9.9')
    expect(ev?.userId).toBeNull()
  })
})

describe('public API routes (no session)', () => {
  it('GET /api/sign/[token] streams the PDF for a valid token and 404s a bad one', async () => {
    const { recipients } = await makeSent('parallel', [{ name: 'Gio', email: 'gio@x.com' }])
    const { GET } = await import('../../src/app/api/sign/[token]/route')

    const okRes = await GET(
      new Request(`http://localhost/api/sign/${recipients[0].token}`) as unknown as Parameters<typeof GET>[0],
      { params: Promise.resolve({ token: recipients[0].token }) },
    )
    expect(okRes.status).toBe(200)
    expect(okRes.headers.get('content-type')).toBe('application/pdf')

    const badRes = await GET(
      new Request('http://localhost/api/sign/nope') as unknown as Parameters<typeof GET>[0],
      { params: Promise.resolve({ token: 'nope' }) },
    )
    expect(badRes.status).toBe(404)
  })

  it('POST /complete rejects a foreign fieldId with 400 and finishes a valid submission', async () => {
    const { id, recipients } = await makeSent('parallel', [
      { name: 'Hana', email: 'hana@x.com' },
      { name: 'Ivo', email: 'ivo@x.com' },
    ])
    const { POST } = await import('../../src/app/api/sign/[token]/complete/route')

    // Hana submitting Ivo's field id → 400 (field-scoping guard on the public route)
    const ivosField = await myFieldId(recipients[1].id)
    const bad = await POST(
      new Request(`http://localhost/api/sign/${recipients[0].token}/complete`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': '3.3.3.3' },
        body: JSON.stringify({ values: [{ fieldId: ivosField, value: PNG_1x1 }] }),
      }) as unknown as Parameters<typeof POST>[0],
      { params: Promise.resolve({ token: recipients[0].token }) },
    )
    expect(bad.status).toBe(400)

    // Hana's own field → 200, recipient signed
    const good = await POST(
      new Request(`http://localhost/api/sign/${recipients[0].token}/complete`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': '3.3.3.3' },
        body: JSON.stringify({ values: [{ fieldId: await myFieldId(recipients[0].id), value: PNG_1x1 }] }),
      }) as unknown as Parameters<typeof POST>[0],
      { params: Promise.resolve({ token: recipients[0].token }) },
    )
    expect(good.status).toBe(200)
    const body = await good.json()
    expect(body.status).toBe('signed') // Ivo hasn't signed yet
    void id
  })
})

describe('phase 3 — email notifications are best-effort (never break the flow)', () => {
  it('sendForSignature still succeeds when email is NOT configured, recording an intended-notification audit', async () => {
    // No EmailConfig row exists in the test DB → the mailer is a no-op. The send
    // must still complete AND record the intended notification (sent:false).
    const { id, recipients } = await makeSent('parallel', [{ name: 'Nora', email: 'nora@x.com' }])

    const doc = await prisma.document.findUnique({ where: { id } })
    expect(doc?.status).toBe('sent') // the send committed despite no email

    const ev = await prisma.auditEvent.findFirst({
      where: { documentId: id, action: 'notify' },
    })
    expect(ev).not.toBeNull()
    const detail = ev!.detail as { kind?: string; sent?: boolean; reason?: string; to?: string }
    expect(detail.kind).toBe('request')
    expect(detail.sent).toBe(false)
    expect(detail.reason).toBe('not_configured')
    expect(detail.to).toBe('nora@x.com')
    void recipients
  })

  it('sequential send only notifies the FIRST recipient', async () => {
    const { id } = await makeSent('sequential', [
      { name: 'One', email: 'one@x.com' },
      { name: 'Two', email: 'two@x.com' },
    ])
    const notifies = await prisma.auditEvent.findMany({ where: { documentId: id, action: 'notify' } })
    const tos = notifies.map((e) => (e.detail as { to?: string }).to)
    expect(tos).toContain('one@x.com')
    expect(tos).not.toContain('two@x.com')
  })
})

describe('phase 4a — new field types + required in the signer flow', () => {
  it('an optional empty field does not block; a required checkbox must be true', async () => {
    const { id } = await createDocument(uid, orgId, 'p4a.pdf', await samplePdfBytes())
    documentIds.push(id)
    const [rec] = await saveRecipients(id, [{ name: 'Cara', email: 'cara' + Date.now() + '@x.com' }])
    await saveFields(id, [
      { page: 1, type: 'checkbox', x: 0.1, y: 0.1, w: 0.04, h: 0.03, value: 'false', required: true, recipientId: rec.id },
      { page: 1, type: 'dropdown', x: 0.2, y: 0.2, w: 0.2, h: 0.05, value: '', required: false, options: { choices: ['A', 'B'] }, recipientId: rec.id },
    ])
    const [link] = await sendForSignature(id, uid)
    const cbId = (await prisma.field.findFirst({ where: { recipientId: rec.id, type: 'checkbox' } }))!.id
    // required checkbox left 'false' → blocked
    const blocked = await completeSigning(link.token, [{ fieldId: cbId, value: 'false' }])
    expect(blocked.ok).toBe(false)
    if (!blocked.ok) expect(blocked.reason).toBe('invalid_values')
    // check it → completes even though the optional dropdown is omitted entirely
    const ok = await completeSigning(link.token, [{ fieldId: cbId, value: 'true' }])
    expect(ok.ok).toBe(true)
    if (ok.ok) expect(ok.completed).toBe(true)
    const doc = await prisma.document.findUnique({ where: { id } })
    expect(doc?.status).toBe('completed')
    // the checkbox persisted as 'true'; the optional dropdown stays empty
    expect((await prisma.field.findUnique({ where: { id: cbId } }))?.value).toBe('true')
  })

  it('a required radio group needs a selection (the chosen option label)', async () => {
    const { id } = await createDocument(uid, orgId, 'p4a-radio.pdf', await samplePdfBytes())
    documentIds.push(id)
    const [rec] = await saveRecipients(id, [{ name: 'Rex', email: 'rex' + Date.now() + '@x.com' }])
    await saveFields(id, [
      { page: 1, type: 'radio', x: 0.1, y: 0.1, w: 0.04, h: 0.03, value: '', required: true, options: { group: 'g', label: 'Yes' }, recipientId: rec.id },
      { page: 1, type: 'radio', x: 0.1, y: 0.2, w: 0.04, h: 0.03, value: '', required: true, options: { group: 'g', label: 'No' }, recipientId: rec.id },
    ])
    const [link] = await sendForSignature(id, uid)
    const fields = await prisma.field.findMany({ where: { recipientId: rec.id }, orderBy: { y: 'asc' } })
    // no selection → blocked
    const blocked = await completeSigning(link.token, fields.map((f) => ({ fieldId: f.id, value: '' })))
    expect(blocked.ok).toBe(false)
    // select 'Yes' → the group's chosen label propagates to both members
    const ok = await completeSigning(link.token, fields.map((f) => ({ fieldId: f.id, value: 'Yes' })))
    expect(ok.ok).toBe(true)
    if (ok.ok) expect(ok.completed).toBe(true)
  })
})

describe('phase 4c — document expiry', () => {
  it('sendForSignature with expiresInDays stamps a future expiresAt', async () => {
    const { id } = await createDocument(uid, orgId, 'exp-set.pdf', await samplePdfBytes())
    documentIds.push(id)
    const [rec] = await saveRecipients(id, [{ name: 'Ex', email: 'exp-set@x.com' }])
    await saveFields(id, [{ page: 1, type: 'signature', x: 0.1, y: 0.1, w: 0.2, h: 0.05, value: '', recipientId: rec.id }])
    await sendForSignature(id, uid, {}, { expiresInDays: 7 })
    const doc = await prisma.document.findUnique({ where: { id } })
    expect(doc?.expiresAt).not.toBeNull()
    expect(doc!.expiresAt!.getTime()).toBeGreaterThan(Date.now())
    // ~7 days out (allow generous slack)
    expect(doc!.expiresAt!.getTime() - Date.now()).toBeGreaterThan(6 * 24 * 3600 * 1000)
  })

  it('an EXPIRED sent document blocks viewing AND completing with reason expired', async () => {
    const { id, recipients } = await makeSent('parallel', [{ name: 'Late', email: 'late@x.com' }])
    // Force the deadline into the past.
    await prisma.document.update({ where: { id }, data: { expiresAt: new Date(Date.now() - 1000) } })

    const view = await viewSigner(recipients[0].token)
    expect(view.ok).toBe(false)
    if (!view.ok) expect(view.reason).toBe('expired')

    const done = await completeSigning(recipients[0].token, [{ fieldId: await myFieldId(recipients[0].id), value: PNG_1x1 }])
    expect(done.ok).toBe(false)
    if (!done.ok) expect(done.reason).toBe('expired')

    // The recipient never advanced to signed and the doc is still `sent`.
    const rec = await prisma.recipient.findUnique({ where: { id: recipients[0].id } })
    expect(rec?.status).not.toBe('signed')
    const doc = await prisma.document.findUnique({ where: { id } })
    expect(doc?.status).toBe('sent')
  })

  it('a NON-expired (future deadline) document still signs to completion', async () => {
    const { id, recipients } = await makeSent('parallel', [{ name: 'OnTime', email: 'ontime@x.com' }])
    await prisma.document.update({ where: { id }, data: { expiresAt: new Date(Date.now() + 24 * 3600 * 1000) } })
    const done = await completeSigning(recipients[0].token, [{ fieldId: await myFieldId(recipients[0].id), value: PNG_1x1 }])
    expect(done.ok).toBe(true)
    if (done.ok) expect(done.completed).toBe(true)
    const doc = await prisma.document.findUnique({ where: { id } })
    expect(doc?.status).toBe('completed')
  })
})

describe('sequential order enforcement', () => {
  it('recipient 2 must wait until recipient 1 has signed', async () => {
    const { recipients } = await makeSent('sequential', [
      { name: 'First', email: 'first@x.com' },
      { name: 'Second', email: 'second@x.com' },
    ])
    // out of turn: second cannot even view-as-signable
    const early = await viewSigner(recipients[1].token)
    expect(early.ok).toBe(false)
    if (!early.ok) expect(early.reason).toBe('waiting')
    // and cannot complete out of turn
    const blocked = await completeSigning(recipients[1].token, [{ fieldId: await myFieldId(recipients[1].id), value: PNG_1x1 }])
    expect(blocked.ok).toBe(false)
    if (!blocked.ok) expect(blocked.reason).toBe('waiting')

    // first signs → now it's second's turn
    await completeSigning(recipients[0].token, [{ fieldId: await myFieldId(recipients[0].id), value: PNG_1x1 }])
    const now = await viewSigner(recipients[1].token)
    expect(now.ok).toBe(true)
  })
})
