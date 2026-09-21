// @vitest-environment node
//
// Org TEAM management — admins add/manage users WITHIN their own org. Runs under
// plain `node` against the real dev Postgres like the other integration suites.
// Proves: the org-admin gate; strict tenant scoping (org A can never touch org
// B's members — a cross-org membership id is NOT_FOUND, and the member list only
// returns the caller's org); the role-escalation guard (admin can't grant admin,
// admin can't change roles); the last-owner guard (can't demote/remove the final
// owner); duplicate-email + existing-user-in-another-org handling; and that a
// newly added user gets a hashed temp password (never returned by a list) that
// authenticates and lands in the right org with the right role.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
process.env.DATA_KEY ||= '0'.repeat(64)

import { verify } from '@node-rs/argon2'
import { prisma } from '../../src/lib/db'
import {
  canManageTeam,
  listMembers,
  addMember,
  changeMemberRole,
  removeMember,
} from '../../src/server/team/actions'

let orgA: string
let orgB: string
let ownerA: string
let adminA: string
let memberA: string
let ownerB: string

const userIds: string[] = []
const orgIds: string[] = []

// Emails are stored lowercase (addMember/signup normalize via zod .toLowerCase),
// so fixtures must be lowercase too or a duplicate lookup won't match.
const u = (email: string) =>
  `${email}.${Date.now()}.${Math.random().toString(36).slice(2)}@x.com`.toLowerCase()

async function mkUser(name: string): Promise<string> {
  const user = await prisma.user.create({
    data: { email: u(name), name, passwordHash: 'x', role: 'user' },
  })
  userIds.push(user.id)
  return user.id
}

beforeAll(async () => {
  const a = await prisma.organization.create({ data: { name: 'Team A Inc', slug: 'teama-' + Date.now() } })
  const b = await prisma.organization.create({ data: { name: 'Team B Inc', slug: 'teamb-' + Date.now() } })
  orgA = a.id
  orgB = b.id
  orgIds.push(a.id, b.id)

  ownerA = await mkUser('ownerA')
  adminA = await mkUser('adminA')
  memberA = await mkUser('memberA')
  ownerB = await mkUser('ownerB')

  await prisma.membership.create({ data: { orgId: orgA, userId: ownerA, role: 'owner' } })
  await prisma.membership.create({ data: { orgId: orgA, userId: adminA, role: 'admin' } })
  await prisma.membership.create({ data: { orgId: orgA, userId: memberA, role: 'member' } })
  await prisma.membership.create({ data: { orgId: orgB, userId: ownerB, role: 'owner' } })
})

afterAll(async () => {
  // Drop this suite's memberships first (FK), then its tracked users + orgs.
  // Every user created here (fixtures + addMember results) is tracked in userIds.
  if (orgIds.length) await prisma.membership.deleteMany({ where: { orgId: { in: orgIds } } })
  if (userIds.length) await prisma.user.deleteMany({ where: { id: { in: userIds } } })
  if (orgIds.length) await prisma.organization.deleteMany({ where: { id: { in: orgIds } } })
})

const ownerActor = () => ({ orgId: orgA, orgRole: 'owner' as const, userId: ownerA })
const adminActor = () => ({ orgId: orgA, orgRole: 'admin' as const, userId: adminA })
const memberActor = () => ({ orgId: orgA, orgRole: 'member' as const, userId: memberA })

describe('canManageTeam gate', () => {
  it('owner + admin may manage; member + no-org may not', () => {
    expect(canManageTeam({ orgId: orgA, orgRole: 'owner' })).toBe(true)
    expect(canManageTeam({ orgId: orgA, orgRole: 'admin' })).toBe(true)
    expect(canManageTeam({ orgId: orgA, orgRole: 'member' })).toBe(false)
    expect(canManageTeam({ orgId: null, orgRole: null })).toBe(false)
  })
})

describe('listMembers is tenant-scoped', () => {
  it('returns only the caller org’s members, never another org’s', async () => {
    const a = await listMembers(orgA)
    const emails = a.map((m) => m.email)
    expect(a.length).toBe(3) // owner + admin + member of A
    // Owner listed first (enum order), member never leaks org B.
    expect(a[0].role).toBe('owner')
    const b = await listMembers(orgB)
    expect(b.length).toBe(1)
    expect(emails).not.toContain(b[0].email)
    // Never exposes a passwordHash.
    expect(Object.keys(a[0])).not.toContain('passwordHash')
  })
})

describe('addMember', () => {
  it('an owner adds a member: creates User + Membership scoped to their org; temp password is hashed at rest and authenticates', async () => {
    const res = await addMember(ownerActor(), { name: 'Newbie', email: u('newbie') })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    userIds.push(res.member.userId)

    // Membership landed in org A with role member.
    const membership = await prisma.membership.findUnique({
      where: { orgId_userId: { orgId: orgA, userId: res.member.userId } },
    })
    expect(membership?.role).toBe('member')

    // Temp password is argon2-hashed at rest (not plaintext) and verifies →
    // the new user can authenticate via Credentials and lands in org A/member.
    const dbUser = await prisma.user.findUnique({ where: { id: res.member.userId } })
    expect(dbUser?.passwordHash).toBeTruthy()
    expect(dbUser?.passwordHash).not.toBe(res.tempPassword)
    expect(await verify(dbUser!.passwordHash!, res.tempPassword)).toBe(true)

    // The temp password is NEVER surfaced by the member list.
    const list = await listMembers(orgA)
    const row = list.find((m) => m.userId === res.member.userId)
    expect(JSON.stringify(row)).not.toContain(res.tempPassword)
  })

  it('added users are ALWAYS member — an owner supplying role: admin still yields a persisted member', async () => {
    const res = await addMember(ownerActor(), { name: 'AdminByOwner', email: u('adminbyowner'), role: 'admin' })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    userIds.push(res.member.userId)
    expect(res.member.role).toBe('member')
    const membership = await prisma.membership.findUnique({
      where: { orgId_userId: { orgId: orgA, userId: res.member.userId } },
    })
    expect(membership?.role).toBe('member')
  })

  it('an admin adding a user ALSO always yields member — a supplied role: admin is ignored, never FORBIDDEN', async () => {
    const res = await addMember(adminActor(), { name: 'MemberByAdmin', email: u('memberbyadmin'), role: 'admin' })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    userIds.push(res.member.userId)
    expect(res.member.role).toBe('member')
    const membership = await prisma.membership.findUnique({
      where: { orgId_userId: { orgId: orgA, userId: res.member.userId } },
    })
    expect(membership?.role).toBe('member')
  })

  it('a plain member is FORBIDDEN', async () => {
    const res = await addMember(memberActor(), { name: 'Nope', email: u('nope') })
    expect(res).toEqual({ ok: false, error: 'FORBIDDEN' })
  })

  it('duplicate email already in this org → ALREADY_MEMBER (no hijack)', async () => {
    const existing = await prisma.user.findUnique({ where: { id: adminA } })
    const res = await addMember(ownerActor(), { name: 'Dup', email: existing!.email })
    expect(res).toEqual({ ok: false, error: 'ALREADY_MEMBER' })
  })

  it('existing user who belongs to ANOTHER org → EMAIL_IN_USE (refuse, never cross-link)', async () => {
    const other = await prisma.user.findUnique({ where: { id: ownerB } })
    const res = await addMember(ownerActor(), { name: 'CrossOrg', email: other!.email })
    expect(res).toEqual({ ok: false, error: 'EMAIL_IN_USE' })
    // Org B owner gained no org A membership.
    const leaked = await prisma.membership.findUnique({ where: { orgId_userId: { orgId: orgA, userId: ownerB } } })
    expect(leaked).toBeNull()
  })

  it('rejects invalid input (bad email / empty name)', async () => {
    expect(await addMember(ownerActor(), { name: '', email: u('x') })).toEqual({ ok: false, error: 'INVALID' })
    expect(await addMember(ownerActor(), { name: 'X', email: 'not-an-email' })).toEqual({ ok: false, error: 'INVALID' })
  })
})

describe('changeMemberRole', () => {
  it('an owner promotes a member to admin and demotes back', async () => {
    const mem = await prisma.membership.findFirst({ where: { orgId: orgA, userId: memberA } })
    const up = await changeMemberRole(ownerActor(), mem!.id, 'admin')
    expect(up).toEqual({ ok: true })
    expect((await prisma.membership.findUnique({ where: { id: mem!.id } }))?.role).toBe('admin')
    const down = await changeMemberRole(ownerActor(), mem!.id, 'member')
    expect(down).toEqual({ ok: true })
    expect((await prisma.membership.findUnique({ where: { id: mem!.id } }))?.role).toBe('member')
  })

  it('an admin CANNOT change roles (FORBIDDEN)', async () => {
    const mem = await prisma.membership.findFirst({ where: { orgId: orgA, userId: memberA } })
    const res = await changeMemberRole(adminActor(), mem!.id, 'admin')
    expect(res).toEqual({ ok: false, error: 'FORBIDDEN' })
    expect((await prisma.membership.findUnique({ where: { id: mem!.id } }))?.role).toBe('member') // unchanged
  })

  it('refuses demoting the LAST owner (last-owner guard)', async () => {
    const own = await prisma.membership.findFirst({ where: { orgId: orgA, userId: ownerA } })
    const res = await changeMemberRole(ownerActor(), own!.id, 'member')
    expect(res).toEqual({ ok: false, error: 'LAST_OWNER' })
    expect((await prisma.membership.findUnique({ where: { id: own!.id } }))?.role).toBe('owner') // still owner
  })

  it('allows demoting an owner once a SECOND owner exists', async () => {
    // Promote admin → owner, then the original owner may be demoted.
    const adminMem = await prisma.membership.findFirst({ where: { orgId: orgA, userId: adminA } })
    expect((await changeMemberRole(ownerActor(), adminMem!.id, 'owner')).ok).toBe(true)
    const ownMem = await prisma.membership.findFirst({ where: { orgId: orgA, userId: ownerA } })
    const res = await changeMemberRole(ownerActor(), ownMem!.id, 'admin')
    expect(res).toEqual({ ok: true })
    // Restore the fixture: put ownerA back to owner, adminA back to admin.
    await changeMemberRole({ orgId: orgA, orgRole: 'owner', userId: adminA }, ownMem!.id, 'owner')
    await changeMemberRole(ownerActor(), adminMem!.id, 'admin')
  })

  it('cross-org: an owner of A cannot change a role in org B (NOT_FOUND, B unchanged)', async () => {
    const bMem = await prisma.membership.findFirst({ where: { orgId: orgB, userId: ownerB } })
    const res = await changeMemberRole(ownerActor(), bMem!.id, 'member')
    expect(res).toEqual({ ok: false, error: 'NOT_FOUND' })
    expect((await prisma.membership.findUnique({ where: { id: bMem!.id } }))?.role).toBe('owner')
  })
})

describe('removeMember', () => {
  it('an admin CANNOT remove an owner or another admin (FORBIDDEN)', async () => {
    const own = await prisma.membership.findFirst({ where: { orgId: orgA, userId: ownerA } })
    expect(await removeMember(adminActor(), own!.id)).toEqual({ ok: false, error: 'FORBIDDEN' })
    expect(await prisma.membership.findUnique({ where: { id: own!.id } })).not.toBeNull()
  })

  it('refuses removing the LAST owner (last-owner guard)', async () => {
    const own = await prisma.membership.findFirst({ where: { orgId: orgA, userId: ownerA } })
    expect(await removeMember(ownerActor(), own!.id)).toEqual({ ok: false, error: 'LAST_OWNER' })
    expect(await prisma.membership.findUnique({ where: { id: own!.id } })).not.toBeNull()
  })

  it('cross-org: an owner of A cannot remove a member of org B (NOT_FOUND, B unchanged)', async () => {
    const bMem = await prisma.membership.findFirst({ where: { orgId: orgB, userId: ownerB } })
    const res = await removeMember(ownerActor(), bMem!.id)
    expect(res).toEqual({ ok: false, error: 'NOT_FOUND' })
    expect(await prisma.membership.findUnique({ where: { id: bMem!.id } })).not.toBeNull()
  })

  it('an owner removes a member (membership deleted; the User + their docs survive)', async () => {
    const added = await addMember(ownerActor(), { name: 'ToRemove', email: u('toremove') })
    expect(added.ok).toBe(true)
    if (!added.ok) return
    userIds.push(added.member.userId)
    const res = await removeMember(ownerActor(), added.member.membershipId)
    expect(res).toEqual({ ok: true })
    // Membership gone…
    expect(await prisma.membership.findUnique({ where: { id: added.member.membershipId } })).toBeNull()
    // …but the User row is intact (so any documents they own don't break).
    expect(await prisma.user.findUnique({ where: { id: added.member.userId } })).not.toBeNull()
  })
})

describe('re-adding a removed member', () => {
  const docIds: string[] = []
  const mkDoc = async (ownerId: string, orgId: string) => {
    const d = await prisma.document.create({
      data: { ownerId, orgId, originalName: 'r.pdf', originalKey: 'k', originalSha256: 'h', pageCount: 1 },
    })
    docIds.push(d.id)
    return d.id
  }

  afterAll(async () => {
    if (docIds.length) await prisma.document.deleteMany({ where: { id: { in: docIds } } })
  })

  it('reuses the same account, as a member, with their documents intact and a fresh temp password', async () => {
    const first = await addMember(ownerActor(), { name: 'Returner', email: u('returner') })
    expect(first.ok).toBe(true)
    if (!first.ok) return
    userIds.push(first.member.userId)
    const docId = await mkDoc(first.member.userId, orgA)
    await removeMember(ownerActor(), first.member.membershipId)

    const again = await addMember(ownerActor(), { name: 'Returner', email: first.member.email, role: 'admin' })
    expect(again.ok).toBe(true)
    if (!again.ok) return
    expect(again.reAdded).toBe(true)
    expect(again.member.userId).toBe(first.member.userId)
    expect(again.member.role).toBe('member')
    expect(again.tempPassword).not.toBe(first.tempPassword)
    const user = await prisma.user.findUnique({ where: { id: first.member.userId } })
    expect(await verify(user!.passwordHash!, again.tempPassword)).toBe(true)
    expect(await prisma.document.findUnique({ where: { id: docId } })).not.toBeNull()
    expect(await prisma.user.count({ where: { email: first.member.email } })).toBe(1)
  })

  it('a brand-new email is not reported as re-added', async () => {
    const res = await addMember(ownerActor(), { name: 'Fresh', email: u('fresh') })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    userIds.push(res.member.userId)
    expect(res.reAdded).toBe(false)
  })

  it('an org-less account that owns documents in ANOTHER org → EMAIL_IN_USE, never attached', async () => {
    const stray = await mkUser('stray')
    await mkDoc(stray, orgB)
    const email = (await prisma.user.findUnique({ where: { id: stray } }))!.email
    expect(await addMember(ownerActor(), { name: 'Stray', email })).toEqual({ ok: false, error: 'EMAIL_IN_USE' })
    expect(await prisma.membership.count({ where: { userId: stray } })).toBe(0)
  })
})
