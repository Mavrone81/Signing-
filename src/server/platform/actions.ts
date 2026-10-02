// Server-only core of the PLATFORM-ADMIN provisioning console (Settings →
// Organizations). Kept separate from the Next form actions
// (src/app/(app)/settings/organizations/actions.ts) so the platform-admin gate,
// slug uniqueness, transactional org+owner creation, and the existing-email
// policy are directly unit-testable without a request/redirect context (mirrors
// src/server/team/actions.ts).
//
// SCOPE — this is the deployment super-admin surface, DISTINCT from the per-org
// Settings → Team page (src/server/team/actions.ts). Team is org-owner/admin-
// scoped, member-only, and strictly single-tenant. This module is the ONLY place
// that reads/writes ACROSS all orgs, and EVERY function is gated on
// `canProvision(actor)` (the platform-admin gate). A non-platform-admin — even an
// org owner — is refused (FORBIDDEN) by every function here.
//
// Because the platform admin is provisioning tenants, they MAY designate org
// owners/admins here (createOrganization can seed an owner; createUser accepts
// any OrgRole). This is the sanctioned exception to the Team page's strict
// member-only rule (see src/server/team/actions.ts `addMember` "Role policy") —
// the Team page stays member-only; only this platform surface can mint owners/
// admins, and only for a platform admin.
import type { OrgRole } from '@prisma/client'
import { Prisma } from '@prisma/client'
import { hash } from '@node-rs/argon2'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { deleteObject } from '@/lib/storage'
import { slugify } from '@/lib/slug'
import { generateTempPassword } from '@/lib/temp-password'

// The acting user's platform-admin context — taken from the session
// (session.user.isPlatformAdmin) by the Next action layer, never from a form.
export type PlatformActor = { isPlatformAdmin: boolean }

// The single gate for this whole module: only a platform admin may provision.
// Mirrors isPlatformAdmin(session) from src/lib/auth-providers.ts, but expressed
// over the actor so the core is unit-testable without a Session.
export function canProvision(actor: PlatformActor): boolean {
  return actor.isPlatformAdmin === true
}

// Picks a slug not yet used by any Organization: the slugified base, else
// `<base>-2`, `<base>-3`, … The DB unique constraint is still the source of
// truth (a P2002 in the transaction is handled), this just avoids the common
// case. Same approach as src/app/(auth)/signup/page.tsx.
async function uniqueSlug(orgName: string): Promise<string> {
  const base = slugify(orgName)
  const taken = new Set(
    (
      await prisma.organization.findMany({
        where: { OR: [{ slug: base }, { slug: { startsWith: `${base}-` } }] },
        select: { slug: true },
      })
    ).map((o) => o.slug),
  )
  if (!taken.has(base)) return base
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`
    if (!taken.has(candidate)) return candidate
  }
}

// --- List (cross-tenant — platform-admin only) ---

// Same shape as src/server/team/actions.ts `TeamMember` (reused labels/fields:
// name, email, role, joined date) — this is the cross-tenant analogue, one
// roster per org, never a passwordHash or temp password.
export interface PlatformOrgMember {
  membershipId: string
  userId: string
  name: string
  email: string
  role: OrgRole
  joinedAt: Date
}

export interface PlatformOrg {
  id: string
  name: string
  slug: string
  memberCount: number
  // What the org still holds. Only an org holding nothing can be deleted.
  documentCount: number
  templateCount: number
  envelopeCount: number
  ownerEmails: string[]
  members: PlatformOrgMember[]
  createdAt: Date
}

export type ListOrganizationsResult =
  | { ok: true; orgs: PlatformOrg[] }
  | { ok: false; error: 'FORBIDDEN' }

/**
 * List EVERY organization on the platform: name, slug, FULL member roster
 * (every membership — name, email, role, joined date), owner email(s), member
 * count, created date. This is intentionally cross-tenant — it is the ONLY
 * place that lists across orgs, and it is gated on `canProvision`. A non-platform
 * admin is refused (FORBIDDEN); it never returns any org data to them. Returns
 * only non-secret profile fields — never a passwordHash or temp password.
 *
 * Member ordering mirrors the Team page's `listMembers`: owners, then admins,
 * then members, each group oldest-first (OrgRole enum order: owner, admin,
 * member — `orderBy: { role: 'asc' }`).
 */
export async function listOrganizations(actor: PlatformActor): Promise<ListOrganizationsResult> {
  if (!canProvision(actor)) return { ok: false, error: 'FORBIDDEN' }
  const rows = await prisma.organization.findMany({
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      name: true,
      slug: true,
      createdAt: true,
      _count: { select: { documents: true, templates: true, envelopes: true } },
      // Full roster per org — never selects passwordHash. Ordering matches
      // src/server/team/actions.ts `listMembers` (owners→admins→members,
      // oldest-first within each group).
      memberships: {
        orderBy: [{ role: 'asc' }, { createdAt: 'asc' }],
        select: {
          id: true,
          role: true,
          createdAt: true,
          userId: true,
          user: { select: { name: true, email: true } },
        },
      },
    },
  })
  return {
    ok: true,
    orgs: rows.map((o) => {
      const members: PlatformOrgMember[] = o.memberships.map((m) => ({
        membershipId: m.id,
        userId: m.userId,
        name: m.user.name,
        email: m.user.email,
        role: m.role,
        joinedAt: m.createdAt,
      }))
      return {
        id: o.id,
        name: o.name,
        slug: o.slug,
        memberCount: members.length,
        documentCount: o._count.documents,
        templateCount: o._count.templates,
        envelopeCount: o._count.envelopes,
        ownerEmails: members.filter((m) => m.role === 'owner').map((m) => m.email),
        members,
        createdAt: o.createdAt,
      }
    }),
  }
}

// --- Delete an EMPTY organization ---

export type DeleteOrganizationResult =
  | { ok: true }
  | { ok: false; error: 'FORBIDDEN' | 'NOT_FOUND' }
  | { ok: false; error: 'NOT_EMPTY'; documents: number; templates: number; envelopes: number }

/**
 * Delete an organization that holds nothing: no documents, templates or
 * envelopes. Platform-admin only. An org holding any is refused (NOT_EMPTY, with the
 * counts) and left untouched — this is for clearing out a mistaken or unused
 * org, never for deleting anyone's records.
 *
 * Its memberships, API keys, webhooks, email server and signing certificates go
 * with it (cascade); the member ACCOUNTS stay, just without this org, so they
 * can be re-added elsewhere. The emptiness check and the delete run in one
 * transaction, so a document created in between cannot be swept away.
 */
export async function deleteOrganization(actor: PlatformActor, orgId: string): Promise<DeleteOrganizationResult> {
  if (!canProvision(actor)) return { ok: false, error: 'FORBIDDEN' }
  if (!orgId || typeof orgId !== 'string') return { ok: false, error: 'NOT_FOUND' }

  const outcome = await prisma.$transaction(async (tx) => {
    const org = await tx.organization.findUnique({
      where: { id: orgId },
      select: {
        logoKey: true,
        signingCertificates: { select: { p12Key: true } },
        _count: { select: { documents: true, templates: true, envelopes: true } },
      },
    })
    if (!org) return { ok: false as const, error: 'NOT_FOUND' as const }
    const { documents, templates, envelopes } = org._count
    if (documents > 0 || templates > 0 || envelopes > 0) {
      return { ok: false as const, error: 'NOT_EMPTY' as const, documents, templates, envelopes }
    }
    await tx.organization.delete({ where: { id: orgId } })
    return { ok: true as const, blobs: [org.logoKey, ...org.signingCertificates.map((c) => c.p12Key)] }
  })

  if (!outcome.ok) return outcome
  // The org's encrypted blobs (logo, certificate keys) have no rows left pointing
  // at them. Best-effort: a leftover blob is harmless, a failed delete isn't fatal.
  for (const key of outcome.blobs) {
    if (!key) continue
    try {
      await deleteObject(key)
    } catch (err) {
      console.error('[platform] could not remove a deleted org blob:', err instanceof Error ? err.message : String(err))
    }
  }
  return { ok: true }
}

// --- Create organization (optionally with an initial owner) ---

// Org name is always required. The owner is optional; if EITHER owner field is
// supplied, BOTH must be — an org may also be created with no owner (the admin
// can provision users into it afterwards via createUser).
const createOrgSchema = z
  .object({
    orgName: z.string().trim().min(1).max(120),
    ownerName: z.string().trim().max(120).optional(),
    ownerEmail: z.string().trim().toLowerCase().email().optional().or(z.literal('')),
  })
  .transform((v) => ({
    orgName: v.orgName,
    ownerName: v.ownerName?.trim() ? v.ownerName.trim() : undefined,
    ownerEmail: v.ownerEmail ? v.ownerEmail : undefined,
  }))

export type CreateOrganizationInput = {
  orgName: string
  ownerName?: string
  ownerEmail?: string
}

export type CreatedOrg = { id: string; name: string; slug: string }

export type CreateOrganizationResult =
  | {
      ok: true
      org: CreatedOrg
      // Present ONLY when an initial owner was created. The temp password is
      // returned ONCE here (argon2-hashed at rest, never returned again).
      owner?: { userId: string; name: string; email: string; tempPassword: string }
    }
  | { ok: false; error: 'FORBIDDEN' | 'INVALID' | 'EMAIL_IN_USE' }

/**
 * Create an organization, optionally seeding its initial OWNER in one atomic
 * transaction — a failure leaves neither the org nor the owner behind.
 *
 * Existing-email policy (documented decision, same rationale as the Team
 * module): the initial owner must be a BRAND-NEW email. If the supplied owner
 * email already exists ANYWHERE on the platform → EMAIL_IN_USE (we never cross-
 * link an existing account as another org's owner; login/JWT lands a user in
 * their first membership only, so quietly re-homing an account would be a
 * cross-tenant footgun). Managing/moving existing users is out of scope.
 *
 * The owner's temp password is CSPRNG-generated, argon2-hashed at rest, and
 * returned ONCE for the admin to share; it is never logged or returned again.
 */
export async function createOrganization(
  actor: PlatformActor,
  input: CreateOrganizationInput,
): Promise<CreateOrganizationResult> {
  if (!canProvision(actor)) return { ok: false, error: 'FORBIDDEN' }

  const parsed = createOrgSchema.safeParse({
    orgName: input.orgName,
    ownerName: input.ownerName,
    ownerEmail: input.ownerEmail,
  })
  if (!parsed.success) return { ok: false, error: 'INVALID' }
  const { orgName, ownerName, ownerEmail } = parsed.data

  // An owner is seeded only when BOTH name and email are given. Supplying just
  // one is a form error, not a silent no-owner create.
  const wantsOwner = !!(ownerName || ownerEmail)
  if (wantsOwner && !(ownerName && ownerEmail)) return { ok: false, error: 'INVALID' }

  // No initial owner → just create the org (admin adds users later).
  if (!wantsOwner) {
    const slug = await uniqueSlug(orgName)
    try {
      const org = await prisma.organization.create({ data: { name: orgName, slug } })
      return { ok: true, org: { id: org.id, name: org.name, slug: org.slug } }
    } catch (err) {
      // Slug race → surface as INVALID rather than a 500 (retry with a new name).
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        return { ok: false, error: 'INVALID' }
      }
      throw err
    }
  }

  // Seeding an owner: refuse a reused email BEFORE hashing (no cross-org hijack).
  const existing = await prisma.user.findUnique({ where: { email: ownerEmail! }, select: { id: true } })
  if (existing) return { ok: false, error: 'EMAIL_IN_USE' }

  const tempPassword = generateTempPassword()
  const passwordHash = await hash(tempPassword)
  const slug = await uniqueSlug(orgName)

  try {
    // Org + owner User + owner Membership commit together — a partial create
    // would leave an org with no owner (or an owner with no org).
    const result = await prisma.$transaction(async (tx) => {
      const org = await tx.organization.create({ data: { name: orgName, slug } })
      const user = await tx.user.create({
        data: { email: ownerEmail!, name: ownerName!, passwordHash, role: 'user' },
      })
      await tx.membership.create({ data: { orgId: org.id, userId: user.id, role: 'owner' } })
      return { org, user }
    })
    return {
      ok: true,
      org: { id: result.org.id, name: result.org.name, slug: result.org.slug },
      owner: { userId: result.user.id, name: result.user.name, email: result.user.email, tempPassword },
    }
  } catch (err) {
    // Unique-constraint race (email or slug) → friendly refusal, never a 500,
    // never leak the temp password.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      // A slug collision is retryable; an email collision is the real conflict.
      const target = (err.meta?.target as string[] | string | undefined) ?? ''
      const onEmail = Array.isArray(target) ? target.includes('email') : String(target).includes('email')
      return { ok: false, error: onEmail ? 'EMAIL_IN_USE' : 'INVALID' }
    }
    throw err
  }
}

// --- Create user into any org, with any role (platform-admin only) ---

const createUserSchema = z.object({
  name: z.string().trim().min(1).max(120),
  email: z.string().trim().toLowerCase().email(),
  orgId: z.string().trim().min(1),
  role: z.enum(['owner', 'admin', 'member']),
})

export type CreateUserInput = { name: string; email: string; orgId: string; role: OrgRole | string }

export type CreateUserResult =
  | {
      ok: true
      tempPassword: string
      user: { userId: string; name: string; email: string; role: OrgRole; orgId: string; membershipId: string }
    }
  | { ok: false; error: 'FORBIDDEN' | 'INVALID' | 'ORG_NOT_FOUND' | 'EMAIL_IN_USE' }

/**
 * Provision a brand-new user into ANY organization with ANY role
 * (owner/admin/member). This is the sanctioned exception to the Team page's
 * strict member-only rule: a platform admin is provisioning tenants, so they may
 * mint owners and admins directly. (The per-org Settings → Team page remains
 * member-only — see src/server/team/actions.ts `addMember`.)
 *
 * Existing-email policy (documented decision, same rationale as the Team
 * module): the email must be BRAND-NEW. If it already exists ANYWHERE → refuse
 * with EMAIL_IN_USE (we never cross-link an existing account into another org;
 * login/JWT lands a user in their first membership only). Managing/moving
 * existing users is out of scope for this module.
 *
 * The temp password is CSPRNG-generated, argon2-hashed at rest, and returned
 * ONCE; it is never logged or returned again.
 */
export async function createUser(actor: PlatformActor, input: CreateUserInput): Promise<CreateUserResult> {
  if (!canProvision(actor)) return { ok: false, error: 'FORBIDDEN' }

  const parsed = createUserSchema.safeParse({
    name: input.name,
    email: input.email,
    orgId: input.orgId,
    role: input.role,
  })
  if (!parsed.success) return { ok: false, error: 'INVALID' }
  const { name, email, orgId, role } = parsed.data

  // The target org must exist (an unknown/deleted orgId is not a 500).
  const org = await prisma.organization.findUnique({ where: { id: orgId }, select: { id: true } })
  if (!org) return { ok: false, error: 'ORG_NOT_FOUND' }

  // Refuse a reused email BEFORE hashing — no cross-org hijack.
  const existing = await prisma.user.findUnique({ where: { email }, select: { id: true } })
  if (existing) return { ok: false, error: 'EMAIL_IN_USE' }

  const tempPassword = generateTempPassword()
  const passwordHash = await hash(tempPassword)

  try {
    // User + Membership commit together.
    const created = await prisma.$transaction(async (tx) => {
      const user = await tx.user.create({ data: { email, name, passwordHash, role: 'user' } })
      const membership = await tx.membership.create({ data: { orgId, userId: user.id, role } })
      return { user, membership }
    })
    return {
      ok: true,
      tempPassword,
      user: {
        userId: created.user.id,
        name: created.user.name,
        email: created.user.email,
        role: created.membership.role,
        orgId: created.membership.orgId,
        membershipId: created.membership.id,
      },
    }
  } catch (err) {
    // Unique-constraint race (email) → EMAIL_IN_USE, never a 500, never leak the
    // temp password.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      return { ok: false, error: 'EMAIL_IN_USE' }
    }
    throw err
  }
}
