'use server'

import { headers } from 'next/headers'
import { revalidatePath } from 'next/cache'
import { auth } from '@/auth'
import { isPlatformAdmin } from '@/lib/auth-providers'
import { createOrganization, createUser, deleteOrganization, type PlatformActor } from '@/server/platform/actions'
import { sendTeamInvite } from '@/server/team/notify'

// The acting user's platform-admin context, taken ALWAYS from the session (never
// a form). Every action below re-checks this gate independently of the page —
// the page's notFound() is defense-in-depth, not the security boundary.
async function actor(): Promise<PlatformActor & { name: string }> {
  const session = await auth()
  return {
    isPlatformAdmin: isPlatformAdmin(session),
    name: session?.user?.name ?? session?.user?.email ?? 'A platform admin',
  }
}

// Resolve the live origin for invite links (best-effort; may be null pre-HTTPS).
async function requestOrigin(): Promise<string | null> {
  const h = await headers()
  const host = h.get('x-forwarded-host') ?? h.get('host')
  const proto = h.get('x-forwarded-proto') ?? 'http'
  return host ? `${proto}://${host}` : null
}

// --- Create organization ---

// The owner's temp password (when an owner is seeded) is surfaced ONCE via this
// action's return value (held in the client component's state) — never
// persisted, never in a URL, never logged.
export type CreateOrgState =
  | { status: 'idle' }
  | { status: 'created'; orgName: string; slug: string }
  | {
      status: 'created'
      orgName: string
      slug: string
      ownerName: string
      ownerEmail: string
      tempPassword: string
      emailed: boolean
    }
  | { status: 'error'; message: string }

const ORG_ERRORS: Record<string, string> = {
  FORBIDDEN: 'You do not have permission to create organizations.',
  INVALID: 'Please enter an organization name (and, if adding an owner, both a name and a valid email).',
  EMAIL_IN_USE: 'That owner email already belongs to another account. Use a new email.',
}

export async function createOrgAction(_prev: CreateOrgState, formData: FormData): Promise<CreateOrgState> {
  const a = await actor()
  const res = await createOrganization(a, {
    orgName: String(formData.get('orgName') ?? ''),
    ownerName: String(formData.get('ownerName') ?? ''),
    ownerEmail: String(formData.get('ownerEmail') ?? ''),
  })
  if (!res.ok) {
    return { status: 'error', message: ORG_ERRORS[res.error] ?? 'Could not create the organization.' }
  }

  revalidatePath('/settings/organizations')

  if (!res.owner) {
    return { status: 'created', orgName: res.org.name, slug: res.org.slug }
  }

  // Best-effort invite email to the new owner (never blocks; temp password is
  // also shown on screen). Reuses the Team invite mailer (branded by the org).
  let emailed = false
  try {
    const sent = await sendTeamInvite({
      orgId: res.org.id,
      toName: res.owner.name,
      toEmail: res.owner.email,
      inviterName: a.name,
      tempPassword: res.owner.tempPassword,
      origin: await requestOrigin(),
    })
    emailed = sent.sent
  } catch {
    // Never let email break provisioning.
  }

  return {
    status: 'created',
    orgName: res.org.name,
    slug: res.org.slug,
    ownerName: res.owner.name,
    ownerEmail: res.owner.email,
    tempPassword: res.owner.tempPassword,
    emailed,
  }
}

// --- Create user (into any org, with any role) ---

export type CreateUserState =
  | { status: 'idle' }
  | {
      status: 'created'
      name: string
      email: string
      role: string
      orgName: string
      tempPassword: string
      emailed: boolean
    }
  | { status: 'error'; message: string }

const USER_ERRORS: Record<string, string> = {
  FORBIDDEN: 'You do not have permission to create users.',
  INVALID: 'Please enter a name, a valid email, a target organization, and a role.',
  ORG_NOT_FOUND: 'That organization no longer exists.',
  EMAIL_IN_USE: 'That email already belongs to another account and cannot be added here. Use a new email.',
}

export async function createUserAction(_prev: CreateUserState, formData: FormData): Promise<CreateUserState> {
  const a = await actor()
  const orgId = String(formData.get('orgId') ?? '')
  const res = await createUser(a, {
    name: String(formData.get('name') ?? ''),
    email: String(formData.get('email') ?? ''),
    orgId,
    role: String(formData.get('role') ?? ''),
  })
  if (!res.ok) {
    return { status: 'error', message: USER_ERRORS[res.error] ?? 'Could not create the user.' }
  }

  // Best-effort invite email (never blocks; temp password shown on screen too).
  let emailed = false
  try {
    const sent = await sendTeamInvite({
      orgId: res.user.orgId,
      toName: res.user.name,
      toEmail: res.user.email,
      inviterName: a.name,
      tempPassword: res.tempPassword,
      origin: await requestOrigin(),
    })
    emailed = sent.sent
  } catch {
    // Never let email break provisioning.
  }

  revalidatePath('/settings/organizations')
  return {
    status: 'created',
    name: res.user.name,
    email: res.user.email,
    role: res.user.role,
    orgName: String(formData.get('orgName') ?? ''),
    tempPassword: res.tempPassword,
    emailed,
  }
}

// --- Delete an empty organization ---

export type DeleteOrgState = { status: 'idle' } | { status: 'deleted' } | { status: 'error'; message: string }

export async function deleteOrgAction(_prev: DeleteOrgState, formData: FormData): Promise<DeleteOrgState> {
  const res = await deleteOrganization(await actor(), String(formData.get('orgId') ?? ''))
  revalidatePath('/settings/organizations')
  if (res.ok) return { status: 'deleted' }
  if (res.error === 'NOT_EMPTY') {
    const parts = [
      res.documents ? `${res.documents} document${res.documents === 1 ? '' : 's'}` : '',
      res.templates ? `${res.templates} template${res.templates === 1 ? '' : 's'}` : '',
      res.envelopes ? `${res.envelopes} envelope${res.envelopes === 1 ? '' : 's'}` : '',
    ].filter(Boolean)
    return { status: 'error', message: `This organization still holds ${parts.join(', ')}, so it can’t be deleted.` }
  }
  if (res.error === 'NOT_FOUND') return { status: 'error', message: 'That organization no longer exists.' }
  return { status: 'error', message: 'You do not have permission to delete organizations.' }
}
