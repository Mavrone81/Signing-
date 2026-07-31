'use client'

import { useActionState, useState } from 'react'
import type { OrgRole } from '@prisma/client'
import { addMemberAction, changeRoleAction, removeMemberAction, type AddMemberState } from './actions'
import type { TeamMember } from '@/server/team/actions'

const fieldClass =
  'w-full rounded-lg border border-edge-strong bg-paper px-3 py-2 text-[14px] text-ink outline-none focus:border-brand-primary focus:ring-1 focus:ring-brand-primary'

function fmt(d: Date | string): string {
  return new Date(d).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

const ROLE_LABEL: Record<OrgRole, string> = { owner: 'Owner', admin: 'Admin', member: 'Member' }

export function TeamManager({
  members,
  isOwner,
  currentUserId,
  emailConfigured,
}: {
  members: TeamMember[]
  isOwner: boolean
  currentUserId: string
  emailConfigured: boolean
}) {
  const [state, action, pending] = useActionState<AddMemberState, FormData>(addMemberAction, {
    status: 'idle',
  })
  const [copied, setCopied] = useState(false)

  async function copy(pw: string) {
    try {
      await navigator.clipboard.writeText(pw)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // Clipboard may be unavailable (non-secure context) — user can select+copy.
    }
  }

  return (
    <div className="mt-6 space-y-8">
      {/* Add a user */}
      <form action={action} className="flex flex-wrap items-end gap-3">
        <div className="min-w-[180px] flex-1">
          <label className="mb-1.5 block text-[13px] font-medium text-ink">Name</label>
          <input name="name" type="text" placeholder="Jane Doe" maxLength={120} required className={fieldClass} />
        </div>
        <div className="min-w-[200px] flex-1">
          <label className="mb-1.5 block text-[13px] font-medium text-ink">Email</label>
          <input name="email" type="email" placeholder="jane@company.com" required className={fieldClass} />
        </div>
        <button
          type="submit"
          disabled={pending}
          className="rounded-lg bg-brand-primary px-4 py-2.5 text-[14px] font-medium text-white transition-colors hover:bg-brand-primary-dark disabled:opacity-60"
        >
          {pending ? 'Adding…' : 'Add user'}
        </button>
      </form>
      <p className="mt-1.5 text-[12px] text-muted">Added users get document &amp; signing access.</p>

      {state.status === 'error' && (
        <div className="rounded-lg border border-danger/30 bg-danger/5 px-4 py-2.5 text-[13px] text-danger">
          {state.message}
        </div>
      )}

      {/* Temp password — shown ONCE. */}
      {state.status === 'created' && (
        <div className="rounded-xl border border-brand-primary/30 bg-brand-primary/5 p-4">
          <p className="text-[13px] font-medium text-ink">
            {state.name} ({state.email}) was added as {ROLE_LABEL[state.role as OrgRole] ?? state.role}. Share this
            temporary password with them — it won’t be shown again. They can change it after signing in.
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <code className="break-all rounded-lg border border-edge-strong bg-paper px-3 py-2 text-[13px] text-ink">
              {state.tempPassword}
            </code>
            <button
              type="button"
              onClick={() => copy(state.tempPassword)}
              className="rounded-lg border border-edge-strong px-3 py-2 text-[13px] font-medium text-ink hover:bg-shell"
            >
              {copied ? 'Copied!' : 'Copy'}
            </button>
          </div>
          <p className="mt-2 text-[12px] text-muted">
            {state.emailed
              ? 'An invite email with these details was also sent.'
              : emailConfigured
                ? 'We could not send the invite email — share the password above directly.'
                : 'Email is not configured, so share the password above directly.'}
          </p>
        </div>
      )}

      {/* Members */}
      <div>
        <h2 className="mb-2 text-[15px] font-semibold text-ink">Members</h2>
        <div className="overflow-x-auto rounded-xl border border-edge">
          <table className="w-full min-w-[620px] text-left text-[13px]">
            <thead className="bg-shell text-muted">
              <tr>
                <th className="px-4 py-2.5 font-medium">Name</th>
                <th className="px-4 py-2.5 font-medium">Email</th>
                <th className="px-4 py-2.5 font-medium">Role</th>
                <th className="px-4 py-2.5 font-medium">Joined</th>
                <th className="px-4 py-2.5" />
              </tr>
            </thead>
            <tbody>
              {members.map((m) => {
                const isSelf = m.userId === currentUserId
                // An admin may remove plain members only; an owner may remove anyone
                // (the server still enforces the last-owner guard).
                const canRemove = isOwner || m.role === 'member'
                return (
                  <tr key={m.membershipId} className="border-t border-edge align-middle">
                    <td className="px-4 py-2.5 text-ink">
                      {m.name}
                      {isSelf && <span className="ml-1.5 text-[11px] text-muted">(you)</span>}
                    </td>
                    <td className="px-4 py-2.5 text-muted">{m.email}</td>
                    <td className="px-4 py-2.5">
                      {isOwner ? (
                        // Only an owner can change roles.
                        <form action={changeRoleAction} className="flex items-center gap-1.5">
                          <input type="hidden" name="membershipId" value={m.membershipId} />
                          <select name="role" defaultValue={m.role} className="rounded-md border border-edge-strong bg-paper px-2 py-1 text-[13px] text-ink">
                            <option value="owner">Owner</option>
                            <option value="admin">Admin</option>
                            <option value="member">Member</option>
                          </select>
                          <button type="submit" className="rounded-md border border-edge-strong px-2 py-1 text-[12px] font-medium text-ink hover:bg-shell">
                            Save
                          </button>
                        </form>
                      ) : (
                        <span className="text-ink">{ROLE_LABEL[m.role]}</span>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-muted">{fmt(m.joinedAt)}</td>
                    <td className="px-4 py-2.5 text-right">
                      {canRemove && (
                        <form action={removeMemberAction}>
                          <input type="hidden" name="membershipId" value={m.membershipId} />
                          <button type="submit" className="text-[13px] font-medium text-danger hover:underline">
                            Remove
                          </button>
                        </form>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-[12px] text-muted">
          The organization must always keep at least one owner.
        </p>
      </div>
    </div>
  )
}
