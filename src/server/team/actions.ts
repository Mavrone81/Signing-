// Server-only core of ORG TEAM management (Settings → Team). Kept separate from
// the Next form actions (src/app/(app)/settings/team/actions.ts) so the
// org-admin gate, tenant scoping, and role/last-owner guards are directly
// unit-testable without a request/redirect context (mirrors
// src/server/branding/actions.ts and src/server/api-keys/actions.ts).
//
// EVERY operation is scoped to `actor.orgId`: an owner/admin of org A can never
// list, add, modify, or remove members of org B — a cross-org membership id is a
// NOT_FOUND, never a cross-tenant write. Nothing here ever returns a temp
// password except addMember's one-time creation result.
import type { OrgRole } from '@prisma/client'
import { Prisma } from '@prisma/client'
import { hash } from '@node-rs/argon2'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { generateTempPassword } from '@/lib/temp-password'

// The acting user's tenancy context — their active org, role in it, and id.
export type TeamActor = { orgId: string | null; orgRole: OrgRole | null; userId: string }

// Only an org OWNER or ADMIN of an actual org may reach team management. A plain
// member or a user with no membership is denied (NOT a platform-admin gate —
// every org's admin manages their own org).
export function canManageTeam(actor: { orgId: string | null; orgRole: OrgRole | null }): boolean {
  return !!actor.orgId && (actor.orgRole === 'owner' || actor.orgRole === 'admin')
}

export interface TeamMember {
  membershipId: string
  userId: string
  name: string
  email: string
  role: OrgRole
  joinedAt: Date
}

type MembershipRow = {
  id: string
  role: OrgRole
  createdAt: Date
  userId: string
  user: { name: string; email: string }
}

function toMember(m: MembershipRow): TeamMember {
  return {
    membershipId: m.id,
    userId: m.userId,
    name: m.user.name,
    email: m.user.email,
    role: m.role,
    joinedAt: m.createdAt,
  }
}

const MEMBER_SELECT = {
  id: true,
  role: true,
  createdAt: true,
  userId: true,
  user: { select: { name: true, email: true } },
} as const

/**
 * List the members of a single org, owners first then admins then members, each
 * group oldest-first. Strictly scoped to `orgId` — never returns another org's
 * members. Returns only non-secret profile fields (never passwordHash).
 */
export async function listMembers(orgId: string): Promise<TeamMember[]> {
  const rows = await prisma.membership.findMany({
    where: { orgId },
    orderBy: [{ role: 'asc' }, { createdAt: 'asc' }], // OrgRole enum order: owner, admin, member
    select: MEMBER_SELECT,
  })
  return rows.map(toMember)
}

const addSchema = z.object({
  name: z.string().trim().min(1).max(120),
  email: z.string().trim().toLowerCase().email(),
})

// `role` is intentionally accepted-but-ignored: even if a caller supplies one
// (e.g. a stale client, or a test asserting the guard), addMember always
// persists `member`. See the "Role policy" note below.
export type AddMemberInput = { name: string; email: string; role?: OrgRole | string }

export type AddMemberResult =
  | { ok: true; tempPassword: string; member: TeamMember }
  | { ok: false; error: 'FORBIDDEN' | 'INVALID' | 'ALREADY_MEMBER' | 'EMAIL_IN_USE' }

/**
 * Add a user to the actor's org.
 *
 * Role policy (documented decision): a user added via this action is ALWAYS
 * given the `member` role (document + signing access) — never `admin` or
 * `owner`, regardless of who adds them (owner or admin) or any role value a
 * caller might supply. Promoting an existing member to `admin` (or `owner`) is
 * a separate, owner-only action (`changeMemberRole`) and is unaffected by this
 * function.
 *
 * Existing-email policy (documented decision): we NEVER hijack an existing
 * account. If the email already belongs to a member of THIS org → ALREADY_MEMBER.
 * If it belongs to an account that exists (in another org, or otherwise) → we
 * REFUSE with EMAIL_IN_USE rather than silently attaching a cross-org membership.
 * A User CAN technically hold memberships in several orgs (Membership is unique
 * per [orgId,userId], not globally), but the login/JWT lands a user in their
 * FIRST membership only, so quietly cross-linking an account would be surprising
 * and a cross-tenant footgun — we refuse instead. Only a brand-new email creates
 * a fresh User (argon2-hashed temp password) + Membership.
 *
 * On success the freshly generated temp password is returned ONCE (for the admin
 * to share / email); it is argon2-hashed at rest and never returned again.
 */
export async function addMember(actor: TeamActor, input: AddMemberInput): Promise<AddMemberResult> {
  if (!canManageTeam(actor)) return { ok: false, error: 'FORBIDDEN' }
  const orgId = actor.orgId as string

  const parsed = addSchema.safeParse({ name: input.name, email: input.email })
  if (!parsed.success) return { ok: false, error: 'INVALID' }
  const { name, email } = parsed.data
  // Added users are always plain members — never admin or owner. Any caller-
  // supplied role is ignored; this is not a guard to bypass, it's the policy.
  const role: OrgRole = 'member'

  const existing = await prisma.user.findUnique({ where: { email }, select: { id: true } })
  if (existing) {
    const inThisOrg = await prisma.membership.findUnique({
      where: { orgId_userId: { orgId, userId: existing.id } },
      select: { id: true },
    })
    if (inThisOrg) return { ok: false, error: 'ALREADY_MEMBER' }
    // Exists but not in this org → refuse (no cross-org hijack). See policy above.
    return { ok: false, error: 'EMAIL_IN_USE' }
  }

  const tempPassword = generateTempPassword()
  const passwordHash = await hash(tempPassword)

  try {
    // User + Membership commit together: a partial create would leave an account
    // with no org membership.
    const membership = await prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: { email, name, passwordHash, role: 'user' },
      })
      return tx.membership.create({
        data: { orgId, userId: user.id, role },
        select: MEMBER_SELECT,
      })
    })
    return { ok: true, tempPassword, member: toMember(membership) }
  } catch (err) {
    // Unique-constraint race (a concurrent add created this email first) →
    // surface as EMAIL_IN_USE rather than a 500. Never leak the temp password.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      return { ok: false, error: 'EMAIL_IN_USE' }
    }
    throw err
  }
}

export type ChangeRoleResult =
  | { ok: true }
  | { ok: false; error: 'FORBIDDEN' | 'NOT_FOUND' | 'INVALID' | 'LAST_OWNER' }

/**
 * Change a member's role within the actor's org.
 *
 * Policy (documented decision): only an OWNER may change roles. An admin cannot
 * change any role (returns FORBIDDEN) — this is the strict form of "an admin
 * cannot grant owner": an admin can never escalate anyone. An owner may set the
 * target to owner / admin / member (promoting a second owner is how ownership is
 * shared or transferred). The LAST owner can never be demoted — the org must
 * always retain at least one owner.
 */
export async function changeMemberRole(
  actor: TeamActor,
  membershipId: string,
  newRole: OrgRole | string,
): Promise<ChangeRoleResult> {
  if (!canManageTeam(actor)) return { ok: false, error: 'FORBIDDEN' }
  // Role changes are owner-only (prevents an admin escalating others).
  if (actor.orgRole !== 'owner') return { ok: false, error: 'FORBIDDEN' }
  if (newRole !== 'owner' && newRole !== 'admin' && newRole !== 'member') {
    return { ok: false, error: 'INVALID' }
  }

  // Tenant scope: the membership must belong to the actor's own org.
  const m = await prisma.membership.findFirst({
    where: { id: membershipId, orgId: actor.orgId as string },
    select: { id: true, role: true },
  })
  if (!m) return { ok: false, error: 'NOT_FOUND' }
  if (m.role === newRole) return { ok: true } // no-op

  // Last-owner guard: refuse demoting the only remaining owner.
  if (m.role === 'owner' && newRole !== 'owner') {
    const owners = await prisma.membership.count({ where: { orgId: actor.orgId as string, role: 'owner' } })
    if (owners <= 1) return { ok: false, error: 'LAST_OWNER' }
  }

  await prisma.membership.update({ where: { id: membershipId }, data: { role: newRole } })
  return { ok: true }
}

export type RemoveMemberResult =
  | { ok: true }
  | { ok: false; error: 'FORBIDDEN' | 'NOT_FOUND' | 'LAST_OWNER' }

/**
 * Remove a member from the actor's org (delete their Membership only — the User
 * row and any Documents they own are left intact, so existing doc queries keep
 * working; a removed user simply loses access to the org).
 *
 * Policy: an OWNER may remove anyone except the last owner. An ADMIN may remove
 * `member`s only — never an owner or another admin. The LAST owner can never be
 * removed.
 */
export async function removeMember(actor: TeamActor, membershipId: string): Promise<RemoveMemberResult> {
  if (!canManageTeam(actor)) return { ok: false, error: 'FORBIDDEN' }

  const m = await prisma.membership.findFirst({
    where: { id: membershipId, orgId: actor.orgId as string },
    select: { id: true, role: true },
  })
  if (!m) return { ok: false, error: 'NOT_FOUND' }

  // An admin may only remove plain members (not owners or other admins).
  if (actor.orgRole !== 'owner' && m.role !== 'member') return { ok: false, error: 'FORBIDDEN' }

  // Last-owner guard.
  if (m.role === 'owner') {
    const owners = await prisma.membership.count({ where: { orgId: actor.orgId as string, role: 'owner' } })
    if (owners <= 1) return { ok: false, error: 'LAST_OWNER' }
  }

  await prisma.membership.delete({ where: { id: membershipId } })
  return { ok: true }
}
