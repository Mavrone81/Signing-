// @vitest-environment node
//
// Phase 5 — public REST API (`/api/v1`, per-org API keys) + signed webhooks.
// Runs under plain `node` (real Postgres + filesystem + pdf-lib) like the other
// integration suites. Proves: an API key scopes strictly to its org (a cross-org
// document id is a 404 on every route); a revoked/invalid/missing key is 401;
// the raw key is never stored or returned after creation; and webhook dispatch
// signs the body with HMAC and is best-effort (a failing endpoint never breaks
// the send flow).
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
process.env.DATA_KEY ||= '0'.repeat(64)
process.env.STORAGE_DIR = '/tmp/ds-apiv1-int-' + Date.now()

import { PDFDocument } from 'pdf-lib'
import { prisma } from '../../src/lib/db'
import { createApiKey, listApiKeys, revokeApiKey } from '../../src/server/api-keys/actions'
import { createWebhook } from '../../src/server/webhooks/actions'
import { hashApiKey } from '../../src/lib/api-keys'
import { signBody } from '../../src/lib/webhooks'
import { sendForSignature } from '../../src/server/documents/actions'

let orgA: string
let orgB: string
let ownerA: string
let ownerB: string
let rawA: string
let rawB: string

const userIds: string[] = []
const orgIds: string[] = []
const documentIds: string[] = []

async function samplePdf(): Promise<Buffer> {
  const d = await PDFDocument.create()
  d.addPage([600, 800])
  return Buffer.from(await d.save())
}

// Build a Bearer request for a v1 route.
function req(url: string, init: RequestInit & { key?: string } = {}): Request {
  const headers = new Headers(init.headers)
  if (init.key) headers.set('authorization', `Bearer ${init.key}`)
  return new Request(`http://localhost${url}`, { ...init, headers })
}

beforeAll(async () => {
  const a = await prisma.organization.create({ data: { name: 'API Org A', slug: 'apia-' + Date.now() } })
  const b = await prisma.organization.create({ data: { name: 'API Org B', slug: 'apib-' + Date.now() } })
  orgA = a.id
  orgB = b.id
  orgIds.push(a.id, b.id)

  const ua = await prisma.user.create({ data: { email: 'apia' + Date.now() + '@x.com', name: 'A', passwordHash: 'x', role: 'user' } })
  const ub = await prisma.user.create({ data: { email: 'apib' + Date.now() + '@x.com', name: 'B', passwordHash: 'x', role: 'user' } })
  ownerA = ua.id
  ownerB = ub.id
  userIds.push(ua.id, ub.id)
  await prisma.membership.create({ data: { orgId: orgA, userId: ownerA, role: 'owner' } })
  await prisma.membership.create({ data: { orgId: orgB, userId: ownerB, role: 'owner' } })

  const ka = await createApiKey({ orgId: orgA, orgRole: 'owner', userId: ownerA }, 'Key A')
  const kb = await createApiKey({ orgId: orgB, orgRole: 'owner', userId: ownerB }, 'Key B')
  if (!ka.ok || !kb.ok) throw new Error('key setup failed')
  rawA = ka.raw
  rawB = kb.raw
})

afterAll(async () => {
  if (documentIds.length) await prisma.document.deleteMany({ where: { id: { in: documentIds } } })
  await prisma.apiKey.deleteMany({ where: { orgId: { in: orgIds } } })
  await prisma.webhook.deleteMany({ where: { orgId: { in: orgIds } } })
  if (userIds.length) await prisma.user.deleteMany({ where: { id: { in: userIds } } })
  if (orgIds.length) await prisma.organization.deleteMany({ where: { id: { in: orgIds } } })
})

describe('API-key storage security', () => {
  it('stores only the hash + prefix, never the raw key', async () => {
    const row = await prisma.apiKey.findFirst({ where: { orgId: orgA, name: 'Key A' } })
    expect(row).toBeTruthy()
    expect(row!.hashedKey).toBe(hashApiKey(rawA))
    expect(rawA.startsWith(row!.prefix)).toBe(true)
    // no column carries the raw secret
    expect(JSON.stringify(row)).not.toContain(rawA)
    // the list surface never returns a hash or raw key
    const listed = await listApiKeys(orgA)
    expect(JSON.stringify(listed)).not.toContain(rawA)
    expect(JSON.stringify(listed)).not.toContain(row!.hashedKey)
  })
})

describe('/api/v1 authentication', () => {
  it('401s a missing Authorization header', async () => {
    const { GET } = await import('../../src/app/api/v1/documents/route')
    const res = await GET(req('/api/v1/documents') as never)
    expect(res.status).toBe(401)
  })

  it('401s an invalid key', async () => {
    const { GET } = await import('../../src/app/api/v1/documents/route')
    const res = await GET(req('/api/v1/documents', { key: 'sk_live_totally-bogus-key-value' }) as never)
    expect(res.status).toBe(401)
  })

  it('401s a revoked key', async () => {
    const k = await createApiKey({ orgId: orgA, orgRole: 'owner', userId: ownerA }, 'Doomed')
    if (!k.ok) throw new Error('create failed')
    const rev = await revokeApiKey({ orgId: orgA, orgRole: 'owner', userId: ownerA }, k.key.id)
    expect(rev.ok).toBe(true)
    const { GET } = await import('../../src/app/api/v1/documents/route')
    const res = await GET(req('/api/v1/documents', { key: k.raw }) as never)
    expect(res.status).toBe(401)
  })
})

describe('/api/v1 full org-scoped document flow', () => {
  let docId: string

  it('POST /documents uploads a PDF scoped to the key org', async () => {
    const { POST } = await import('../../src/app/api/v1/documents/route')
    const form = new FormData()
    form.append('file', new File([new Uint8Array(await samplePdf())], 'api.pdf', { type: 'application/pdf' }))
    const res = await POST(req('/api/v1/documents', { method: 'POST', body: form, key: rawA }) as never)
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.status).toBe('draft')
    docId = body.id
    documentIds.push(docId)
    const doc = await prisma.document.findUnique({ where: { id: docId } })
    expect(doc?.orgId).toBe(orgA)
    expect(doc?.ownerId).toBe(ownerA) // synthetic actor = key creator
  })

  it('POST /recipients + /fields then /send returns signing links', async () => {
    const rcp = await import('../../src/app/api/v1/documents/[id]/recipients/route')
    const rRes = await rcp.POST(
      req(`/api/v1/documents/${docId}/recipients`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ recipients: [{ name: 'Alice', email: 'alice@x.com' }] }),
        key: rawA,
      }) as never,
      { params: Promise.resolve({ id: docId }) },
    )
    expect(rRes.status).toBe(200)
    const rBody = await rRes.json()
    const recipientId = rBody.recipients[0].id
    // token is never exposed in the recipients response
    expect(JSON.stringify(rBody)).not.toContain('token')

    const fld = await import('../../src/app/api/v1/documents/[id]/fields/route')
    const fRes = await fld.POST(
      req(`/api/v1/documents/${docId}/fields`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          fields: [{ page: 1, type: 'signature', x: 0.1, y: 0.1, w: 0.2, h: 0.08, value: '', recipientId }],
        }),
        key: rawA,
      }) as never,
      { params: Promise.resolve({ id: docId }) },
    )
    expect(fRes.status).toBe(200)

    const snd = await import('../../src/app/api/v1/documents/[id]/send/route')
    const sRes = await snd.POST(
      req(`/api/v1/documents/${docId}/send`, { method: 'POST', key: rawA }) as never,
      { params: Promise.resolve({ id: docId }) },
    )
    expect(sRes.status).toBe(200)
    const sBody = await sRes.json()
    expect(sBody.recipients[0].signingUrl).toMatch(/\/sign\/.+/)
    expect((await prisma.document.findUnique({ where: { id: docId } }))?.status).toBe('sent')
  })

  it('GET /documents/{id} returns status + recipients', async () => {
    const { GET } = await import('../../src/app/api/v1/documents/[id]/route')
    const res = await GET(req(`/api/v1/documents/${docId}`, { key: rawA }) as never, {
      params: Promise.resolve({ id: docId }),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.document.status).toBe('sent')
    expect(body.document.recipients).toHaveLength(1)
    expect(body.document.recipients[0].email).toBe('alice@x.com')
  })

  it('GET /documents lists the org’s docs (paginated)', async () => {
    const { GET } = await import('../../src/app/api/v1/documents/route')
    const res = await GET(req('/api/v1/documents?limit=50', { key: rawA }) as never)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.documents.map((d: { id: string }) => d.id)).toContain(docId)
    expect(body.pagination.limit).toBe(50)
  })
})

describe('/api/v1 cross-tenant isolation — an org-A key can never reach org-B data', () => {
  let docBId: string

  beforeAll(async () => {
    // A doc created by key A lives in org A; key B must never touch it.
    const { POST } = await import('../../src/app/api/v1/documents/route')
    const form = new FormData()
    form.append('file', new File([new Uint8Array(await samplePdf())], 'secret.pdf', { type: 'application/pdf' }))
    const res = await POST(req('/api/v1/documents', { method: 'POST', body: form, key: rawA }) as never)
    const body = await res.json()
    docBId = body.id
    documentIds.push(docBId)
  })

  it('GET /documents/{id} with the other org’s key → 404', async () => {
    const { GET } = await import('../../src/app/api/v1/documents/[id]/route')
    const res = await GET(req(`/api/v1/documents/${docBId}`, { key: rawB }) as never, {
      params: Promise.resolve({ id: docBId }),
    })
    expect(res.status).toBe(404)
  })

  it('POST /recipients with the other org’s key → 404 and writes nothing', async () => {
    const { POST } = await import('../../src/app/api/v1/documents/[id]/recipients/route')
    const res = await POST(
      req(`/api/v1/documents/${docBId}/recipients`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ recipients: [{ name: 'Mallory', email: 'm@x.com' }] }),
        key: rawB,
      }) as never,
      { params: Promise.resolve({ id: docBId }) },
    )
    expect(res.status).toBe(404)
    expect(await prisma.recipient.count({ where: { documentId: docBId } })).toBe(0)
  })

  it('POST /send with the other org’s key → 404', async () => {
    const { POST } = await import('../../src/app/api/v1/documents/[id]/send/route')
    const res = await POST(req(`/api/v1/documents/${docBId}/send`, { method: 'POST', key: rawB }) as never, {
      params: Promise.resolve({ id: docBId }),
    })
    expect(res.status).toBe(404)
  })

  it('GET /signed with the other org’s key → 404', async () => {
    const { GET } = await import('../../src/app/api/v1/documents/[id]/signed/route')
    const res = await GET(req(`/api/v1/documents/${docBId}/signed`, { key: rawB }) as never, {
      params: Promise.resolve({ id: docBId }),
    })
    expect(res.status).toBe(404)
  })

  it('GET /documents with the other org’s key never lists org-A docs', async () => {
    const { GET } = await import('../../src/app/api/v1/documents/route')
    const res = await GET(req('/api/v1/documents?limit=100', { key: rawB }) as never)
    const body = await res.json()
    expect(body.documents.map((d: { id: string }) => d.id)).not.toContain(docBId)
  })
})

describe('webhooks — signed delivery + best-effort', () => {
  async function seedSendableDoc(): Promise<string> {
    const { POST } = await import('../../src/app/api/v1/documents/route')
    const form = new FormData()
    form.append('file', new File([new Uint8Array(await samplePdf())], 'wh.pdf', { type: 'application/pdf' }))
    const res = await POST(req('/api/v1/documents', { method: 'POST', body: form, key: rawA }) as never)
    const { id } = await res.json()
    documentIds.push(id)
    const rcp = await import('../../src/app/api/v1/documents/[id]/recipients/route')
    const rRes = await rcp.POST(
      req(`/api/v1/documents/${id}/recipients`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ recipients: [{ name: 'Wendy', email: 'wendy@x.com' }] }),
        key: rawA,
      }) as never,
      { params: Promise.resolve({ id }) },
    )
    const recipientId = (await rRes.json()).recipients[0].id
    const fld = await import('../../src/app/api/v1/documents/[id]/fields/route')
    await fld.POST(
      req(`/api/v1/documents/${id}/fields`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          fields: [{ page: 1, type: 'signature', x: 0.1, y: 0.1, w: 0.2, h: 0.08, value: '', recipientId }],
        }),
        key: rawA,
      }) as never,
      { params: Promise.resolve({ id }) },
    )
    return id
  }

  it('signs document.sent with HMAC-SHA256 over the exact body', async () => {
    const wh = await createWebhook(
      { orgId: orgA, orgRole: 'owner', userId: ownerA },
      'https://example.com/hook',
      ['document.sent'],
    )
    if (!wh.ok) throw new Error('webhook create failed')
    const secret = wh.webhook.secret

    const captured: { body: string; sig: string | null; event: string | null }[] = []
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const h = new Headers((init as RequestInit).headers)
      captured.push({
        body: String((init as RequestInit).body),
        sig: h.get('x-bevorasign-signature'),
        event: h.get('x-bevorasign-event'),
      })
      return new Response('ok', { status: 200 })
    })

    try {
      const id = await seedSendableDoc()
      await sendForSignature(id, ownerA)
    } finally {
      fetchSpy.mockRestore()
    }

    expect(captured.length).toBeGreaterThanOrEqual(1)
    const hit = captured.find((c) => c.event === 'document.sent')!
    expect(hit).toBeTruthy()
    // header is the HMAC of the EXACT delivered body under the endpoint secret
    expect(hit.sig).toBe(`sha256=${signBody(secret, hit.body)}`)
    const parsed = JSON.parse(hit.body)
    expect(parsed.event).toBe('document.sent')
    expect(parsed.data.document).toBeTruthy()
    expect(parsed.timestamp).toBeTruthy()
    // no signing token leaked into the webhook payload
    expect(hit.body).not.toContain('/sign/')
  })

  it('a failing endpoint does not break the send flow (best-effort)', async () => {
    // Ensure at least one enabled webhook subscribed to document.sent for orgA.
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network down'))
    let id: string
    try {
      id = await seedSendableDoc()
      // Must resolve despite the webhook delivery throwing.
      await expect(sendForSignature(id, ownerA)).resolves.toBeTruthy()
    } finally {
      fetchSpy.mockRestore()
    }
    expect((await prisma.document.findUnique({ where: { id } }))?.status).toBe('sent')
  })
})

// Owner-only documents: a key acts as its creator, so an org admin cannot mint
// a key to read a colleague's documents in the same org.
describe('/api/v1 owner-only — a key sees only its creator’s documents', () => {
  let colleague: string
  let colleagueDoc: string

  beforeAll(async () => {
    const c = await prisma.user.create({ data: { email: 'apic' + Date.now() + '@x.com', name: 'C', passwordHash: 'x', role: 'user' } })
    colleague = c.id
    userIds.push(c.id)
    await prisma.membership.create({ data: { orgId: orgA, userId: colleague, role: 'member' } })
    const { createDocument } = await import('../../src/server/documents/actions')
    const d = await createDocument(colleague, orgA, 'colleague.pdf', await samplePdf())
    colleagueDoc = d.id
    documentIds.push(d.id)
  })

  it('GET /documents/{id} for a colleague’s document in the same org → 404', async () => {
    const { GET } = await import('../../src/app/api/v1/documents/[id]/route')
    const res = await GET(req(`/api/v1/documents/${colleagueDoc}`, { key: rawA }) as never, {
      params: Promise.resolve({ id: colleagueDoc }),
    })
    expect(res.status).toBe(404)
  })

  it('GET /documents does not list a colleague’s document', async () => {
    const { GET } = await import('../../src/app/api/v1/documents/route')
    const res = await GET(req('/api/v1/documents?limit=100', { key: rawA }) as never)
    const body = await res.json()
    expect(body.documents.map((d: { id: string }) => d.id)).not.toContain(colleagueDoc)
  })
})
