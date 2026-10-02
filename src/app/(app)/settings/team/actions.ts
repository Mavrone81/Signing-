'use server'

import { headers } from 'next/headers'
import { revalidatePath } from 'next/cache'
import { auth } from '@/auth'
import {
  addMember,
  changeMemberRole,
  removeMember,
  type TeamActor,
} from '@/server/team/actions'
import { sendTeamInvite } from '@/server/team/notify'

// The acting user's tenancy context, taken ALWAYS from the session (never the
// form) — one org can never act on another's members.
async function actor(): Promise<TeamActor & { name: string; email: string }> {
  const session = await auth()
  return {
    orgId: session?.user?.orgId ?? null,
    orgRole: session?.user?.orgRole ?? null,
    userId: session?.user?.id ?? '',
    name: session?.user?.name ?? session?.user?.email ?? 'A teammate',
    email: session?.user?.email ?? '',
  }
}

// The temp password is surfaced ONCE via this action's return value (held in the
// client component's state), never persisted, never put in a URL, never logged.
export type AddMemberState =
  | { status: 'idle' }
  | {
      status: 'created'
      name: string
      email: string
      role: string
      tempPassword: string
      emailed: boolean
      reAdded: boolean
    }
  | { status: 'error'; message: string }

const ADD_ERRORS: Record<string, string> = {
  FORBIDDEN: 'You do not have permission to add users.',
  INVALID: 'Please enter a name and a valid email.',
  ALREADY_MEMBER: 'That person is already a member of this organization.',
  EMAIL_IN_USE: 'That email already belongs to another account and cannot be added here.',
}

export async function addMemberAction(
  _prev: AddMemberState,
  formData: FormData,
): Promise<AddMemberState> {
  const a = await actor()
  const name = String(formData.get('name') ?? '')
  const email = String(formData.get('email') ?? '')

  // Added users are always `member` (document + signing access) — no role is
  // ever read from the form. Promoting to admin is a separate, owner-only
  // action (changeMemberRole) from the members list below.
  const res = await addMember(a, { name, email })
  if (!res.ok) {
    return { status: 'error', message: ADD_ERRORS[res.error] ?? 'Could not add that user.' }
  }

  // Best-effort invite email (never blocks; temp password is shown on screen too).
  let emailed = false
  try {
    const h = await headers()
    const host = h.get('x-forwarded-host') ?? h.get('host')
    const proto = h.get('x-forwarded-proto') ?? 'http'
    const origin = host ? `${proto}://${host}` : null
    const sent = await sendTeamInvite({
      orgId: a.orgId as string,
      toName: res.member.name,
      toEmail: res.member.email,
      inviterName: a.name,
      tempPassword: res.tempPassword,
      origin,
    })
    emailed = sent.sent
  } catch {
    // Never let email break the add.
  }

  revalidatePath('/settings/team')
  return {
    status: 'created',
    name: res.member.name,
    email: res.member.email,
    role: res.member.role,
    tempPassword: res.tempPassword,
    emailed,
    reAdded: res.reAdded,
  }
}

// The outcome of a role change, returned to the row that made it so the UI can
// say what happened (and show the SAVED role, not a stale one).
export type ChangeRoleState =
  | { status: 'idle' }
  | { status: 'saved'; role: string }
  | { status: 'error'; message: string }

const ROLE_ERRORS: Record<string, string> = {
  FORBIDDEN: 'Only an owner can change roles.',
  NOT_FOUND: 'That member is no longer in this organization.',
  INVALID: 'Choose owner, admin or member.',
  LAST_OWNER: 'The organization must keep at least one owner. Make someone else an owner first.',
}

export async function changeRoleAction(
  _prev: ChangeRoleState,
  formData: FormData,
): Promise<ChangeRoleState> {
  const membershipId = String(formData.get('membershipId') ?? '')
  const role = String(formData.get('role') ?? '')
  const res = await changeMemberRole(await actor(), membershipId, role)
  revalidatePath('/settings/team')
  if (!res.ok) return { status: 'error', message: ROLE_ERRORS[res.error] ?? 'Could not change the role.' }
  return { status: 'saved', role }
}

export async function removeMemberAction(formData: FormData): Promise<void> {
  const membershipId = String(formData.get('membershipId') ?? '')
  await removeMember(await actor(), membershipId)
  revalidatePath('/settings/team')
}
