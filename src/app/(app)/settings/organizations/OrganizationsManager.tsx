'use client'

import { useActionState, useState } from 'react'
import {
  createOrgAction,
  createUserAction,
  deleteOrgAction,
  type CreateOrgState,
  type CreateUserState,
  type DeleteOrgState,
} from './actions'
import type { PlatformOrg } from '@/server/platform/actions'

const fieldClass =
  'w-full rounded-lg border border-edge-strong bg-paper px-3 py-2 text-[14px] text-ink outline-none focus:border-brand-primary focus:ring-1 focus:ring-brand-primary'

function fmt(d: Date | string): string {
  return new Date(d).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

const ROLE_LABEL: Record<string, string> = { owner: 'Owner', admin: 'Admin', member: 'Member' }

// Same role-badge treatment used elsewhere in the settings UI (owner/admin/
// member color-coded pills).
const ROLE_BADGE_CLASS: Record<string, string> = {
  owner: 'bg-brand-primary/10 text-brand-primary',
  admin: 'bg-warn/10 text-warn',
  member: 'bg-shell text-muted',
}

function RoleBadge({ role }: { role: string }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[12px] font-medium ${
        ROLE_BADGE_CLASS[role] ?? ROLE_BADGE_CLASS.member
      }`}
    >
      {ROLE_LABEL[role] ?? role}
    </span>
  )
}

// Reusable one-time temp-password panel (copy-to-clipboard). Mirrors the Team
// page: the password is shown ONCE and never returned again by any read.
// Delete control for one org. Offered only when the org holds nothing (the
// server re-checks and refuses otherwise); asks for confirmation first.
function DeleteOrgCell({ org }: { org: PlatformOrg }) {
  const [state, action, pending] = useActionState<DeleteOrgState, FormData>(deleteOrgAction, { status: 'idle' })
  const empty = org.documentCount === 0 && org.templateCount === 0
  if (!empty) {
    return <span className="text-[12px] text-muted">Holds records</span>
  }
  return (
    <form
      action={action}
      onSubmit={(e) => {
        const who = org.memberCount ? ` Its ${org.memberCount} member account(s) stay, without this organization.` : ''
        if (!window.confirm(`Delete “${org.name}”? This can’t be undone.${who}`)) e.preventDefault()
      }}
    >
      <input type="hidden" name="orgId" value={org.id} />
      <button type="submit" disabled={pending} className="text-[13px] font-medium text-danger hover:underline disabled:opacity-60">
        {pending ? 'Deleting…' : 'Delete'}
      </button>
      {state.status === 'error' && (
        <p role="alert" className="mt-1 max-w-[220px] text-[12px] text-danger">
          {state.message}
        </p>
      )}
    </form>
  )
}

function TempPasswordPanel({
  heading,
  tempPassword,
  emailed,
  emailConfigured,
}: {
  heading: string
  tempPassword: string
  emailed: boolean
  emailConfigured: boolean
}) {
  const [copied, setCopied] = useState(false)
  async function copy() {
    try {
      await navigator.clipboard.writeText(tempPassword)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // Clipboard may be unavailable (non-secure context) — user can select+copy.
    }
  }
  return (
    <div className="mt-4 rounded-xl border border-brand-primary/30 bg-brand-primary/5 p-4">
      <p className="text-[13px] font-medium text-ink">{heading}</p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <code className="break-all rounded-lg border border-edge-strong bg-paper px-3 py-2 text-[13px] text-ink">
          {tempPassword}
        </code>
        <button
          type="button"
          onClick={copy}
          className="rounded-lg border border-edge-strong px-3 py-2 text-[13px] font-medium text-ink hover:bg-shell"
        >
          {copied ? 'Copied!' : 'Copy'}
        </button>
      </div>
      <p className="mt-2 text-[12px] text-muted">
        {emailed
          ? 'An invite email with these details was also sent.'
          : emailConfigured
            ? 'We could not send the invite email — share the password above directly.'
            : 'Email is not configured, so share the password above directly.'}
      </p>
    </div>
  )
}

function CreateOrgForm({ emailConfigured }: { emailConfigured: boolean }) {
  const [state, action, pending] = useActionState<CreateOrgState, FormData>(createOrgAction, {
    status: 'idle',
  })

  return (
    <section className="rounded-xl border border-edge bg-paper p-6">
      <h2 className="text-[16px] font-semibold text-ink">Create organization</h2>
      <p className="mt-0.5 text-[13px] text-muted">
        Create a new tenant. Optionally seed its first owner — leave the owner fields blank to
        create an empty org and add users to it afterwards.
      </p>

      <form action={action} className="mt-4 space-y-4">
        <div>
          <label className="mb-1.5 block text-[13px] font-medium text-ink">Organization name</label>
          <input name="orgName" type="text" placeholder="Acme Pte Ltd" maxLength={120} required className={fieldClass} />
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className="mb-1.5 block text-[13px] font-medium text-ink">
              Owner name <span className="font-normal text-muted">(optional)</span>
            </label>
            <input name="ownerName" type="text" placeholder="Jane Doe" maxLength={120} className={fieldClass} />
          </div>
          <div>
            <label className="mb-1.5 block text-[13px] font-medium text-ink">
              Owner email <span className="font-normal text-muted">(optional)</span>
            </label>
            <input name="ownerEmail" type="email" placeholder="jane@acme.com" className={fieldClass} />
          </div>
        </div>
        <button
          type="submit"
          disabled={pending}
          className="rounded-lg bg-brand-primary px-4 py-2.5 text-[14px] font-medium text-white transition-colors hover:bg-brand-primary-dark disabled:opacity-60"
        >
          {pending ? 'Creating…' : 'Create organization'}
        </button>
      </form>

      {state.status === 'error' && (
        <div className="mt-4 rounded-lg border border-danger/30 bg-danger/5 px-4 py-2.5 text-[13px] text-danger">
          {state.message}
        </div>
      )}

      {state.status === 'created' && !('tempPassword' in state) && (
        <div className="mt-4 rounded-lg border border-edge bg-shell px-4 py-2.5 text-[13px] text-ink">
          Organization <span className="font-medium">{state.orgName}</span> created (slug{' '}
          <code>{state.slug}</code>). Add users to it below.
        </div>
      )}

      {state.status === 'created' && 'tempPassword' in state && (
        <TempPasswordPanel
          heading={`Organization ${state.orgName} created with owner ${state.ownerName} (${state.ownerEmail}). Share this one-time password — it won’t be shown again.`}
          tempPassword={state.tempPassword}
          emailed={state.emailed}
          emailConfigured={emailConfigured}
        />
      )}
    </section>
  )
}

function CreateUserForm({ orgs, emailConfigured }: { orgs: PlatformOrg[]; emailConfigured: boolean }) {
  const [state, action, pending] = useActionState<CreateUserState, FormData>(createUserAction, {
    status: 'idle',
  })
  // Track the selected org so we can pass its name through for the success
  // message (the action needs a display name; orgId is the source of truth).
  const [orgId, setOrgId] = useState(orgs[0]?.id ?? '')
  const selectedOrgName = orgs.find((o) => o.id === orgId)?.name ?? ''

  return (
    <section className="rounded-xl border border-edge bg-paper p-6">
      <h2 className="text-[16px] font-semibold text-ink">Provision a user</h2>
      <p className="mt-0.5 text-[13px] text-muted">
        Create a new user in any organization with any role. Owner and admin roles are available
        here (platform provisioning) — the per-org Team page adds members only.
      </p>

      {orgs.length === 0 ? (
        <p className="mt-4 text-[13px] text-muted">Create an organization first.</p>
      ) : (
        <form action={action} className="mt-4 space-y-4">
          <input type="hidden" name="orgName" value={selectedOrgName} />
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className="mb-1.5 block text-[13px] font-medium text-ink">Name</label>
              <input name="name" type="text" placeholder="Jane Doe" maxLength={120} required className={fieldClass} />
            </div>
            <div>
              <label className="mb-1.5 block text-[13px] font-medium text-ink">Email</label>
              <input name="email" type="email" placeholder="jane@company.com" required className={fieldClass} />
            </div>
            <div>
              <label className="mb-1.5 block text-[13px] font-medium text-ink">Organization</label>
              <select
                name="orgId"
                value={orgId}
                onChange={(e) => setOrgId(e.target.value)}
                required
                className={fieldClass}
              >
                {orgs.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name} ({o.slug})
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="mb-1.5 block text-[13px] font-medium text-ink">Role</label>
              <select name="role" defaultValue="member" required className={fieldClass}>
                <option value="owner">Owner</option>
                <option value="admin">Admin</option>
                <option value="member">Member</option>
              </select>
            </div>
          </div>
          <button
            type="submit"
            disabled={pending}
            className="rounded-lg bg-brand-primary px-4 py-2.5 text-[14px] font-medium text-white transition-colors hover:bg-brand-primary-dark disabled:opacity-60"
          >
            {pending ? 'Creating…' : 'Create user'}
          </button>
        </form>
      )}

      {state.status === 'error' && (
        <div className="mt-4 rounded-lg border border-danger/30 bg-danger/5 px-4 py-2.5 text-[13px] text-danger">
          {state.message}
        </div>
      )}

      {state.status === 'created' && (
        <TempPasswordPanel
          heading={`${state.name} (${state.email}) added as ${ROLE_LABEL[state.role] ?? state.role}${
            state.orgName ? ` in ${state.orgName}` : ''
          }. Share this one-time password — it won’t be shown again.`}
          tempPassword={state.tempPassword}
          emailed={state.emailed}
          emailConfigured={emailConfigured}
        />
      )}
    </section>
  )
}

export function OrganizationsManager({
  orgs,
  emailConfigured,
}: {
  orgs: PlatformOrg[]
  emailConfigured: boolean
}) {
  return (
    <div className="mt-6 space-y-6">
      <CreateOrgForm emailConfigured={emailConfigured} />
      <CreateUserForm orgs={orgs} emailConfigured={emailConfigured} />

      {/* All organizations (cross-tenant — platform-admin only). */}
      <div>
        <h2 className="mb-2 text-[15px] font-semibold text-ink">All organizations</h2>
        <div className="overflow-x-auto rounded-xl border border-edge">
          <table className="w-full min-w-[640px] text-left text-[13px]">
            <thead className="bg-shell text-muted">
              <tr>
                <th className="px-4 py-2.5 font-medium">Name</th>
                <th className="px-4 py-2.5 font-medium">Slug</th>
                <th className="px-4 py-2.5 font-medium">Owner(s)</th>
                <th className="px-4 py-2.5 font-medium">Members</th>
                <th className="px-4 py-2.5 font-medium">Created</th>
                <th className="px-4 py-2.5" />
              </tr>
            </thead>
            <tbody>
              {orgs.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-4 text-muted">
                    No organizations yet.
                  </td>
                </tr>
              ) : (
                orgs.map((o) => (
                  <tr key={o.id} className="border-t border-edge align-middle">
                    <td className="px-4 py-2.5 text-ink">{o.name}</td>
                    <td className="px-4 py-2.5 text-muted">
                      <code>{o.slug}</code>
                    </td>
                    <td className="px-4 py-2.5 text-muted">
                      {o.ownerEmails.length ? o.ownerEmails.join(', ') : <span className="italic">no owner</span>}
                    </td>
                    <td className="px-4 py-2.5 text-ink">
                      <details>
                        <summary className="cursor-pointer select-none text-ink hover:text-brand-primary">
                          {o.memberCount} {o.memberCount === 1 ? 'member' : 'members'}
                        </summary>
                        {o.members.length > 0 && (
                          <ul className="mt-2 space-y-1.5 border-l border-edge pl-3">
                            {o.members.map((m) => (
                              <li key={m.membershipId} className="flex flex-wrap items-center gap-2">
                                <span className="text-ink">{m.name}</span>
                                <span className="text-muted">{m.email}</span>
                                <RoleBadge role={m.role} />
                              </li>
                            ))}
                          </ul>
                        )}
                      </details>
                    </td>
                    <td className="px-4 py-2.5 text-muted">{fmt(o.createdAt)}</td>
                    <td className="px-4 py-2.5 text-right">
                      <DeleteOrgCell org={o} />
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
