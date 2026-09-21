// @vitest-environment node
//
// PLATFORM-ADMIN provisioning console (Settings → Organizations). Runs under
// plain `node` against the real dev Postgres like the other integration suites.
// Proves: the platform-admin gate (a non-platform-admin — even an org owner — is
// refused create-org AND create-user AND the cross-tenant list); create-org with
// and without an initial owner (unique slug; owner gets role owner + a hashed
// temp password that authenticates); create-user into a chosen org with each
// role (owner/admin/member) lands the right Membership; existing-email →
// EMAIL_IN_USE; ORG_NOT_FOUND for an unknown org; temp passwords are hashed at
// rest and never returned by a list.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
process.env.DATA_KEY ||= '0'.repeat(64)

import { verify } from '@node-rs/argon2'
import { prisma } from '../../src/lib/db'
import {
  canProvision,
  listOrganizations,
  createOrganization,
  createUser,
  deleteOrganization,
} from '../../src/server/platform/actions'

const admin = { isPlatformAdmin: true }
const notAdmin = { isPlatformAdmin: false }

// Unique lowercase email per fixture (emails are stored lowercased).
const u = (email: string) =>
  `${email}.${Date.now()}.${Math.random().toString(36).slice(2)}@x.com`.toLowerCase()

const userIds: string[] = []
const orgIds: string[] = []
const track = (r: { org?: { id: string }; owner?: { userId: string } }) => {
  if (r.org) orgIds.push(r.org.id)
  if (r.owner) userIds.push(r.owner.userId)
}

let existingOrg: string
let existingUserEmail: string

beforeAll(async () => {
  const org = await prisma.organization.create({
    data: { name: 'Preexisting Co', slug: 'preexisting-' + Date.now() },
  })
  existingOrg = org.id
  orgIds.push(org.id)
  const user = await prisma.user.create({
    data: { email: u('preexisting'), name: 'Pre Existing', passwordHash: 'x', role: 'user' },
  })
  existingUserEmail = user.email
  userIds.push(user.id)
  await prisma.membership.create({ data: { orgId: existingOrg, userId: user.id, role: 'owner' } })
})

afterAll(async () => {
  if (orgIds.length) await prisma.membership.deleteMany({ where: { orgId: { in: orgIds } } })
  if (userIds.length) await prisma.user.deleteMany({ where: { id: { in: userIds } } })
  if (orgIds.length) await prisma.organization.deleteMany({ where: { id: { in: orgIds } } })
})

describe('canProvision gate', () => {
  it('only a platform admin may provision', () => {
    expect(canProvision(admin)).toBe(true)
    expect(canProvision(notAdmin)).toBe(false)
  })
})

describe('platform-admin gate refuses a non-platform-admin (even an org owner)', () => {
  it('refuses create-org, create-user, and the cross-tenant list', async () => {
    // An org owner is isPlatformAdmin=false — the whole console is closed to them.
    const org = await createOrganization(notAdmin, { orgName: 'Should Not Exist' })
    expect(org).toEqual({ ok: false, error: 'FORBIDDEN' })

    const user = await createUser(notAdmin, {
      name: 'Nope',
      email: u('nope'),
      orgId: existingOrg,
      role: 'admin',
    })
    expect(user).toEqual({ ok: false, error: 'FORBIDDEN' })

    const list = await listOrganizations(notAdmin)
    expect(list).toEqual({ ok: false, error: 'FORBIDDEN' })
    expect('orgs' in list).toBe(false) // never leaks any org data to a non-admin
  })
})

describe('createOrganization', () => {
  it('without an owner: creates an empty org with a unique slug (no owner, no temp password)', async () => {
    const res = await createOrganization(admin, { orgName: 'Empty Org Inc' })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    track(res)
    expect(res.owner).toBeUndefined()
    expect(res.org.slug).toBeTruthy()
    const dbOrg = await prisma.organization.findUnique({
      where: { id: res.org.id },
      include: { _count: { select: { memberships: true } } },
    })
    expect(dbOrg?._count.memberships).toBe(0)
  })

  it('with an owner: org + owner Membership(owner) atomically; temp password is hashed at rest and authenticates', async () => {
    const email = u('owner')
    const res = await createOrganization(admin, {
      orgName: 'Seeded Org LLC',
      ownerName: 'Olivia Owner',
      ownerEmail: email,
    })
    expect(res.ok).toBe(true)
    if (!res.ok || !res.owner) return
    track(res)

    // Owner membership landed with role owner in the new org.
    const membership = await prisma.membership.findUnique({
      where: { orgId_userId: { orgId: res.org.id, userId: res.owner.userId } },
    })
    expect(membership?.role).toBe('owner')

    // Temp password is argon2-hashed at rest (not plaintext) and verifies.
    const dbUser = await prisma.user.findUnique({ where: { id: res.owner.userId } })
    expect(dbUser?.passwordHash).toBeTruthy()
    expect(dbUser?.passwordHash).not.toBe(res.owner.tempPassword)
    expect(await verify(dbUser!.passwordHash!, res.owner.tempPassword)).toBe(true)
  })

  it('assigns unique slugs when two orgs share a name', async () => {
    const a = await createOrganization(admin, { orgName: 'Dup Slug Co' })
    const b = await createOrganization(admin, { orgName: 'Dup Slug Co' })
    expect(a.ok && b.ok).toBe(true)
    if (!a.ok || !b.ok) return
    track(a)
    track(b)
    expect(a.org.slug).not.toBe(b.org.slug)
  })

  it('refuses a reused owner email (EMAIL_IN_USE, no org left behind)', async () => {
    const before = await prisma.organization.count()
    const res = await createOrganization(admin, {
      orgName: 'Reused Owner Co',
      ownerName: 'Dup',
      ownerEmail: existingUserEmail,
    })
    expect(res).toEqual({ ok: false, error: 'EMAIL_IN_USE' })
    // Atomicity: the org was NOT created (transaction never ran / rolled back).
    expect(await prisma.organization.count()).toBe(before)
  })

  it('rejects a half-specified owner (name without email) as INVALID', async () => {
    const res = await createOrganization(admin, { orgName: 'Half Owner Co', ownerName: 'Only Name' })
    expect(res).toEqual({ ok: false, error: 'INVALID' })
  })

  it('rejects an empty org name', async () => {
    expect(await createOrganization(admin, { orgName: '   ' })).toEqual({ ok: false, error: 'INVALID' })
  })
})

describe('createUser (into any org, with any role)', () => {
  for (const role of ['owner', 'admin', 'member'] as const) {
    it(`provisions a ${role} into a chosen org with the right Membership + a working temp password`, async () => {
      const res = await createUser(admin, {
        name: `New ${role}`,
        email: u(role),
        orgId: existingOrg,
        role,
      })
      expect(res.ok).toBe(true)
      if (!res.ok) return
      userIds.push(res.user.userId)

      const membership = await prisma.membership.findUnique({
        where: { orgId_userId: { orgId: existingOrg, userId: res.user.userId } },
      })
      expect(membership?.role).toBe(role)

      const dbUser = await prisma.user.findUnique({ where: { id: res.user.userId } })
      expect(dbUser?.passwordHash).not.toBe(res.tempPassword)
      expect(await verify(dbUser!.passwordHash!, res.tempPassword)).toBe(true)
    })
  }

  it('refuses an email that already exists anywhere (EMAIL_IN_USE, no cross-link)', async () => {
    const res = await createUser(admin, {
      name: 'Dup',
      email: existingUserEmail,
      orgId: existingOrg,
      role: 'member',
    })
    expect(res).toEqual({ ok: false, error: 'EMAIL_IN_USE' })
  })

  it('refuses an unknown org (ORG_NOT_FOUND)', async () => {
    const res = await createUser(admin, {
      name: 'Ghost',
      email: u('ghost'),
      orgId: 'org-that-does-not-exist',
      role: 'member',
    })
    expect(res).toEqual({ ok: false, error: 'ORG_NOT_FOUND' })
  })

  it('rejects an invalid role', async () => {
    const res = await createUser(admin, {
      name: 'Bad Role',
      email: u('badrole'),
      orgId: existingOrg,
      role: 'superuser',
    })
    expect(res).toEqual({ ok: false, error: 'INVALID' })
  })
})

describe('listOrganizations (cross-tenant, platform-admin only)', () => {
  it('lists orgs across tenants with member counts + owner emails; never a temp password/hash', async () => {
    // Seed an org with a known owner so we can assert the shape.
    const created = await createOrganization(admin, {
      orgName: 'Listed Org Co',
      ownerName: 'Liam List',
      ownerEmail: u('liam'),
    })
    expect(created.ok).toBe(true)
    if (!created.ok || !created.owner) return
    track(created)

    const list = await listOrganizations(admin)
    expect(list.ok).toBe(true)
    if (!list.ok) return

    const row = list.orgs.find((o) => o.id === created.org.id)
    expect(row).toBeTruthy()
    expect(row!.memberCount).toBe(1)
    expect(row!.ownerEmails).toContain(created.owner.email)

    // The list spans more than one org (cross-tenant) and never leaks secrets.
    expect(list.orgs.length).toBeGreaterThan(1)
    expect(JSON.stringify(list.orgs)).not.toContain(created.owner.tempPassword)
    expect(JSON.stringify(list.orgs)).not.toContain('passwordHash')
  })

  it('returns the FULL member roster per org (name/email/role/joined), ordered owners→admins→members oldest-first, with no passwordHash leak', async () => {
    // Seed an org with an owner, then provision an admin and two members (in a
    // deliberately mixed creation order) to prove the roster is re-sorted, not
    // just returned in insertion order.
    const created = await createOrganization(admin, {
      orgName: 'Rostered Org Co',
      ownerName: 'Ollie Owner',
      ownerEmail: u('ollie'),
    })
    expect(created.ok).toBe(true)
    if (!created.ok || !created.owner) return
    track(created)
    const orgId = created.org.id

    const memberFirst = await createUser(admin, {
      name: 'Mia MemberFirst',
      email: u('mia'),
      orgId,
      role: 'member',
    })
    expect(memberFirst.ok).toBe(true)
    if (memberFirst.ok) userIds.push(memberFirst.user.userId)

    const adminUser = await createUser(admin, {
      name: 'Adam Admin',
      email: u('adam'),
      orgId,
      role: 'admin',
    })
    expect(adminUser.ok).toBe(true)
    if (adminUser.ok) userIds.push(adminUser.user.userId)

    const memberSecond = await createUser(admin, {
      name: 'Mel MemberSecond',
      email: u('mel'),
      orgId,
      role: 'member',
    })
    expect(memberSecond.ok).toBe(true)
    if (memberSecond.ok) userIds.push(memberSecond.user.userId)

    const list = await listOrganizations(admin)
    expect(list.ok).toBe(true)
    if (!list.ok) return

    const row = list.orgs.find((o) => o.id === orgId)
    expect(row).toBeTruthy()
    if (!row) return

    // Full roster: every membership present (owner + admin + 2 members).
    expect(row.members).toHaveLength(4)
    expect(row.memberCount).toBe(4)

    // Ordering: owner, then admin, then members oldest-first.
    expect(row.members.map((m) => m.role)).toEqual(['owner', 'admin', 'member', 'member'])
    expect(row.members.map((m) => m.email)).toEqual([
      created.owner.email,
      adminUser.ok ? adminUser.user.email : '',
      memberFirst.ok ? memberFirst.user.email : '',
      memberSecond.ok ? memberSecond.user.email : '',
    ])

    // Each entry carries name/email/role/joined — the same shape as the Team
    // page's TeamMember.
    for (const m of row.members) {
      expect(m.membershipId).toBeTruthy()
      expect(m.userId).toBeTruthy()
      expect(m.name).toBeTruthy()
      expect(m.email).toBeTruthy()
      expect(['owner', 'admin', 'member']).toContain(m.role)
      expect(m.joinedAt).toBeTruthy()
    }

    // Never a passwordHash or temp password anywhere in the payload.
    const serialized = JSON.stringify(list.orgs)
    expect(serialized).not.toContain('passwordHash')
    expect(serialized).not.toContain(memberFirst.ok ? memberFirst.tempPassword : '__none__')
    expect(serialized).not.toContain(adminUser.ok ? adminUser.tempPassword : '__none__')
    expect(serialized).not.toContain(created.owner.tempPassword)
  })
})

describe('deleteOrganization (empty orgs only, platform-admin only)', () => {
  async function freshOrg(): Promise<string> {
    const o = await prisma.organization.create({ data: { name: 'Doomed', slug: 'doomed-' + Date.now() + Math.random().toString(36).slice(2) } })
    orgIds.push(o.id)
    return o.id
  }

  it('refuses a non-platform admin and leaves the org', async () => {
    const id = await freshOrg()
    expect(await deleteOrganization(notAdmin, id)).toEqual({ ok: false, error: 'FORBIDDEN' })
    expect(await prisma.organization.findUnique({ where: { id } })).not.toBeNull()
  })

  it('deletes an empty org; its member accounts survive without it', async () => {
    const id = await freshOrg()
    const user = await prisma.user.create({ data: { email: u('orphan'), name: 'O', passwordHash: 'x', role: 'user' } })
    userIds.push(user.id)
    await prisma.membership.create({ data: { orgId: id, userId: user.id, role: 'owner' } })

    expect(await deleteOrganization(admin, id)).toEqual({ ok: true })
    expect(await prisma.organization.findUnique({ where: { id } })).toBeNull()
    expect(await prisma.user.findUnique({ where: { id: user.id } })).not.toBeNull()
    expect(await prisma.membership.count({ where: { userId: user.id } })).toBe(0)
  })

  it('refuses an org holding a document (NOT_EMPTY with counts), untouched', async () => {
    const id = await freshOrg()
    const user = await prisma.user.create({ data: { email: u('docowner'), name: 'D', passwordHash: 'x', role: 'user' } })
    userIds.push(user.id)
    const doc = await prisma.document.create({
      data: { ownerId: user.id, orgId: id, originalName: 'k.pdf', originalKey: 'k', originalSha256: 'h', pageCount: 1 },
    })
    const res = await deleteOrganization(admin, id)
    expect(res).toEqual({ ok: false, error: 'NOT_EMPTY', documents: 1, templates: 0, envelopes: 0 })
    expect(await prisma.organization.findUnique({ where: { id } })).not.toBeNull()
    await prisma.document.delete({ where: { id: doc.id } })
  })

  it('refuses an org holding a template', async () => {
    const id = await freshOrg()
    const t = await prisma.template.create({
      data: { orgId: id, name: 'T', storageKey: 'k', pageCount: 1, createdById: 'x' },
    })
    expect(await deleteOrganization(admin, id)).toEqual({ ok: false, error: 'NOT_EMPTY', documents: 0, templates: 1, envelopes: 0 })
    await prisma.template.delete({ where: { id: t.id } })
  })

  it('refuses an org holding an envelope', async () => {
    const id = await freshOrg()
    const user = await prisma.user.create({ data: { email: u('envowner'), name: 'E', passwordHash: 'x', role: 'user' } })
    userIds.push(user.id)
    const env = await prisma.envelope.create({ data: { orgId: id, ownerId: user.id, name: 'Env' } })
    expect(await deleteOrganization(admin, id)).toEqual({ ok: false, error: 'NOT_EMPTY', documents: 0, templates: 0, envelopes: 1 })
    await prisma.envelope.delete({ where: { id: env.id } })
  })

  it('NOT_FOUND for an unknown org', async () => {
    expect(await deleteOrganization(admin, 'nope')).toEqual({ ok: false, error: 'NOT_FOUND' })
  })

  it('the listing reports what each org holds', async () => {
    const id = await freshOrg()
    const listed = await listOrganizations(admin)
    const row = listed.ok ? listed.orgs.find((o) => o.id === id) : undefined
    expect(row).toMatchObject({ documentCount: 0, templateCount: 0, envelopeCount: 0 })
  })
})
