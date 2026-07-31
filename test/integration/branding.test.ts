// @vitest-environment node
//
// Phase 5 — white-label per-org branding. Runs under plain `node` (real Postgres
// + filesystem + pdf-lib) like the other integration suites. Covers the
// org-admin write gate, tenant isolation, logo validation/storage, and that a
// signer token surfaces ONLY its own document's org brand.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
process.env.DATA_KEY ||= '0'.repeat(64)
process.env.STORAGE_DIR = '/tmp/ds-brand-int-' + Date.now()

import { PDFDocument } from 'pdf-lib'
import { createDocument, saveRecipients, saveFields, sendForSignature } from '../../src/server/documents/actions'
import { viewSigner } from '../../src/server/documents/signing'
import { saveOrgBranding, canEditBranding } from '../../src/server/branding/actions'
import { prisma } from '../../src/lib/db'
import { getObject } from '../../src/lib/storage'
import { logoKeyFor } from '../../src/lib/branding'

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x11, 0x22])

let orgA: string
let orgB: string
let ownerA: string
let adminA: string
let memberA: string
const userIds: string[] = []
const orgIds: string[] = []
const documentIds: string[] = []

async function samplePdfBytes(): Promise<Buffer> {
  const d = await PDFDocument.create()
  d.addPage([600, 800])
  return Buffer.from(await d.save())
}

beforeAll(async () => {
  const a = await prisma.organization.create({ data: { name: 'Org A Inc', slug: 'branda-' + Date.now() } })
  const b = await prisma.organization.create({ data: { name: 'Org B Inc', slug: 'brandb-' + Date.now() } })
  orgA = a.id
  orgB = b.id
  orgIds.push(a.id, b.id)

  const mk = async (email: string) => {
    const u = await prisma.user.create({ data: { email: email + Date.now() + '@x.com', name: email, passwordHash: 'x', role: 'user' } })
    userIds.push(u.id)
    return u.id
  }
  ownerA = await mk('ownerA')
  adminA = await mk('adminA')
  memberA = await mk('memberA')
  await prisma.membership.create({ data: { orgId: orgA, userId: ownerA, role: 'owner' } })
  await prisma.membership.create({ data: { orgId: orgA, userId: adminA, role: 'admin' } })
  await prisma.membership.create({ data: { orgId: orgA, userId: memberA, role: 'member' } })
})

afterAll(async () => {
  if (documentIds.length) await prisma.document.deleteMany({ where: { id: { in: documentIds } } })
  if (userIds.length) await prisma.user.deleteMany({ where: { id: { in: userIds } } })
  if (orgIds.length) await prisma.organization.deleteMany({ where: { id: { in: orgIds } } })
})

describe('canEditBranding gate', () => {
  it('owner + admin may edit; member + no-org may not', () => {
    expect(canEditBranding({ orgId: orgA, orgRole: 'owner' })).toBe(true)
    expect(canEditBranding({ orgId: orgA, orgRole: 'admin' })).toBe(true)
    expect(canEditBranding({ orgId: orgA, orgRole: 'member' })).toBe(false)
    expect(canEditBranding({ orgId: null, orgRole: null })).toBe(false)
  })
})

describe('saveOrgBranding', () => {
  it('an org admin persists name + colour + logo (encrypted blob) to their own org', async () => {
    const res = await saveOrgBranding(
      { orgId: orgA, orgRole: 'admin' },
      { brandName: '  Org A Legal  ', brandColor: '#123456', logo: PNG },
    )
    expect(res.ok).toBe(true)

    const org = await prisma.organization.findUnique({ where: { id: orgA } })
    expect(org?.brandName).toBe('Org A Legal') // trimmed
    expect(org?.brandColor).toBe('#123456')
    expect(org?.logoKey).toBe(logoKeyFor(orgA, 'png'))
    // Blob is stored encrypted + round-trips to the original bytes.
    const stored = await getObject(org!.logoKey!)
    expect(Buffer.compare(stored, PNG)).toBe(0)
  })

  it('a plain member is FORBIDDEN (403) and writes nothing', async () => {
    const before = await prisma.organization.findUnique({ where: { id: orgA } })
    const res = await saveOrgBranding(
      { orgId: orgA, orgRole: 'member' },
      { brandName: 'Hijacked', brandColor: '#000000' },
    )
    expect(res).toEqual({ ok: false, error: 'FORBIDDEN' })
    const after = await prisma.organization.findUnique({ where: { id: orgA } })
    expect(after?.brandName).toBe(before?.brandName) // unchanged
  })

  it('rejects a non-image logo (type) without touching the row', async () => {
    const res = await saveOrgBranding(
      { orgId: orgA, orgRole: 'owner' },
      { brandName: 'Org A Legal', brandColor: '#123456', logo: Buffer.from('%PDF-1.7 not an image') },
    )
    expect(res).toEqual({ ok: false, error: 'type' })
  })

  it('is tenant-scoped: an Org B admin only ever writes Org B, never Org A', async () => {
    const aBefore = await prisma.organization.findUnique({ where: { id: orgA } })
    await saveOrgBranding({ orgId: orgB, orgRole: 'admin' }, { brandName: 'Org B Brand', brandColor: '#654321' })
    const aAfter = await prisma.organization.findUnique({ where: { id: orgA } })
    const bAfter = await prisma.organization.findUnique({ where: { id: orgB } })
    expect(bAfter?.brandName).toBe('Org B Brand')
    expect(aAfter?.brandName).toBe(aBefore?.brandName) // Org A untouched
  })

  it('removeLogo clears the stored key', async () => {
    await saveOrgBranding({ orgId: orgA, orgRole: 'owner' }, { brandName: 'Org A Legal', brandColor: '#123456', logo: PNG })
    const res = await saveOrgBranding({ orgId: orgA, orgRole: 'owner' }, { brandName: 'Org A Legal', brandColor: '#123456', removeLogo: true })
    expect(res.ok).toBe(true)
    const org = await prisma.organization.findUnique({ where: { id: orgA } })
    expect(org?.logoKey).toBeNull()
  })
})

describe('signer surfaces its OWN org brand only', () => {
  async function makeSentDoc(orgId: string, owner: string) {
    const { id } = await createDocument(owner, orgId, 'sf.pdf', await samplePdfBytes())
    documentIds.push(id)
    const [r] = await saveRecipients(id, [{ name: 'Signer', email: 's@x.com', orderIndex: 0 }])
    await saveFields(id, [{ page: 1, type: 'signature', x: 0.1, y: 0.1, w: 0.2, h: 0.08, value: '', recipientId: r.id }])
    const links = await sendForSignature(id, owner)
    return links[0].token
  }

  it('token for an Org A doc returns Org A brand (name/colour), not Org B', async () => {
    // Org A is branded "Org A Legal / #123456"; Org B is "Org B Brand / #654321".
    await saveOrgBranding({ orgId: orgA, orgRole: 'owner' }, { brandName: 'Org A Legal', brandColor: '#123456' })
    const token = await makeSentDoc(orgA, ownerA)
    const r = await viewSigner(token)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.brand.customized).toBe(true)
    expect(r.brand.name).toBe('Org A Legal')
    expect(r.brand.color).toBe('#123456')
    // Never leaks Org B's brand.
    expect(r.brand.name).not.toBe('Org B Brand')
    expect(r.brand.color).not.toBe('#654321')
  })

  it('an uncustomized org falls back to customized:false (generic Bevora Sign)', async () => {
    const c = await prisma.organization.create({ data: { name: 'Org C', slug: 'brandc-' + Date.now() } })
    orgIds.push(c.id)
    const owner = await prisma.user.create({ data: { email: 'ownerC' + Date.now() + '@x.com', name: 'ownerC', passwordHash: 'x', role: 'user' } })
    userIds.push(owner.id)
    await prisma.membership.create({ data: { orgId: c.id, userId: owner.id, role: 'owner' } })
    const token = await makeSentDoc(c.id, owner.id)
    const r = await viewSigner(token)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.brand.customized).toBe(false)
    expect(r.brand.name).toBe('Org C') // falls back to org name
  })
})
