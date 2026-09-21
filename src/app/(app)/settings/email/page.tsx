import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { auth } from '@/auth'
import { isPlatformAdmin } from '@/lib/auth-providers'
import { canManageOrgSettings } from '@/lib/org-settings'
import {
  describeEmailRoute,
  getOrgEmailConfigForClient,
  getSharedEmailConfigForClient,
  type EmailConfigClientView,
} from '@/lib/email-config'
import { parseEmailRecipient } from '@/lib/email-recipient'
import { saveEmailConfig, saveSharedEmailConfig, sendTestEmail } from './actions'
import { PageHeader } from '@/components/ui/PageHeader'

export const metadata: Metadata = { title: 'Email · Settings · Bevora Sign' }

function fieldClass() {
  return 'w-full rounded-lg border border-edge-strong bg-paper px-3 py-2 text-[14px] text-ink outline-none focus:border-brand-primary focus:ring-1 focus:ring-brand-primary'
}

const TEST_REASON: Record<string, string> = {
  not_configured:
    'Neither your organization’s own server nor the shared server is set up, so no email can be sent yet.',
  error: 'The SMTP server rejected or failed the send. Check the host, port, credentials, and TLS setting.',
  no_admin_email: 'Your account has no email address. Type the address to send the test to.',
  bad_recipient: 'That doesn’t look like an email address.',
}

const VIA_LABEL: Record<string, string> = {
  org: 'your organization’s own server',
  shared: 'the shared server',
}

// The SMTP fields shared by the org form and the shared-server form. The
// password is write-only: the UI only learns whether one is stored.
function SmtpFields({ cfg, enabledLabel }: { cfg: EmailConfigClientView; enabledLabel: string }) {
  return (
    <>
      <label className="flex items-center gap-2.5">
        <input
          name="enabled"
          type="checkbox"
          defaultChecked={cfg.enabled}
          className="h-4 w-4 rounded border-edge-strong text-brand-primary focus:ring-brand-primary"
        />
        <span className="text-[13px] font-medium text-ink">{enabledLabel}</span>
      </label>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div className="sm:col-span-2">
          <label className="mb-1.5 block text-[13px] font-medium text-ink">SMTP host</label>
          <input name="host" type="text" defaultValue={cfg.host} placeholder="smtp.example.com" autoComplete="off" className={fieldClass()} />
        </div>
        <div>
          <label className="mb-1.5 block text-[13px] font-medium text-ink">Port</label>
          <input name="port" type="number" min={1} max={65535} defaultValue={cfg.port} placeholder="587" autoComplete="off" className={fieldClass()} />
        </div>
      </div>

      <label className="flex items-center gap-2.5">
        <input
          name="secure"
          type="checkbox"
          defaultChecked={cfg.secure}
          className="h-4 w-4 rounded border-edge-strong text-brand-primary focus:ring-brand-primary"
        />
        <span className="text-[13px] text-ink">Use TLS (SSL) — on for port 465; off for 587/STARTTLS</span>
      </label>

      <div>
        <label className="mb-1.5 block text-[13px] font-medium text-ink">Username</label>
        <input name="username" type="text" defaultValue={cfg.username} placeholder="SMTP username (optional for open relays)" autoComplete="off" className={fieldClass()} />
      </div>

      <div>
        <label className="mb-1.5 block text-[13px] font-medium text-ink">
          Password{' '}
          <span className="font-normal text-muted">
            {cfg.hasPassword ? '(a password is stored — leave blank to keep it)' : '(write-only)'}
          </span>
        </label>
        <input
          name="password"
          type="password"
          placeholder={cfg.hasPassword ? '•••••••• stored' : 'SMTP password'}
          autoComplete="new-password"
          className={fieldClass()}
        />
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <label className="mb-1.5 block text-[13px] font-medium text-ink">From name</label>
          <input name="fromName" type="text" defaultValue={cfg.fromName} placeholder="Bevora Sign" autoComplete="off" className={fieldClass()} />
        </div>
        <div>
          <label className="mb-1.5 block text-[13px] font-medium text-ink">From email</label>
          <input name="fromEmail" type="email" defaultValue={cfg.fromEmail} placeholder="no-reply@example.com" autoComplete="off" className={fieldClass()} />
        </div>
      </div>
    </>
  )
}

export default async function EmailSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ saved?: string; error?: string; test?: string; reason?: string; to?: string; via?: string }>
}) {
  const session = await auth()
  // The org's owners/admins (and platform admins) only — everyone else, and
  // anyone with no org, gets a 404 (no hint the page exists). The actions
  // re-check this gate and take the org from the session.
  const user = session?.user
  if (!canManageOrgSettings(user)) notFound()
  const platformAdmin = isPlatformAdmin(session)

  const { saved, error, test, reason, to, via } = await searchParams
  const [orgCfg, route, sharedCfg] = await Promise.all([
    getOrgEmailConfigForClient(user.orgId),
    describeEmailRoute(user.orgId),
    platformAdmin ? getSharedEmailConfigForClient() : Promise.resolve(null),
  ])

  // Echo only a well-formed address from the query string (a crafted link must
  // not be able to make this page print arbitrary text), and keep the test input
  // on the address that was just tested.
  const testedTo = parseEmailRecipient(to)
  const testedVia = via && VIA_LABEL[via] ? VIA_LABEL[via] : null
  const ownEmail = session!.user.email ?? ''

  return (
    <div className="mx-auto max-w-2xl px-4 py-8 sm:px-6 lg:px-8">
      <PageHeader
        title="Email"
        backHref="/documents"
        subtitle={
          <>
            Signing invitations, reminders, and completed/declined notices for your organization are
            sent through your own SMTP server when you turn it on, and otherwise through the shared
            server. Passwords are stored encrypted and are never shown again after you save them.
          </>
        }
      />

      {saved && (
        <div className="mt-5 rounded-lg border border-edge bg-shell px-4 py-3 text-[13px] text-ink">
          {saved === 'shared' ? 'Shared server settings saved.' : 'Your organization’s email settings saved.'}
        </div>
      )}
      {error === 'port' && (
        <div className="mt-5 rounded-lg border border-warn/35 bg-warn-tint px-4 py-3 text-[13px] text-ink">
          Port must be a number between 1 and 65535.
        </div>
      )}
      {test === 'ok' && testedTo && (
        <div className="mt-5 rounded-lg border border-edge bg-brand-primary-tint px-4 py-3 text-[13px] text-brand-primary-dark">
          Test email sent to <span className="font-medium">{testedTo}</span>
          {testedVia ? <> through {testedVia}</> : null}. Check that inbox.
        </div>
      )}
      {test === 'fail' && (
        <div className="mt-5 rounded-lg border border-warn/35 bg-warn-tint px-4 py-3 text-[13px] text-ink">
          Test email {testedTo ? <>to <span className="font-medium">{testedTo}</span> </> : null}failed
          {testedVia ? <> (through {testedVia})</> : null}. {TEST_REASON[reason ?? ''] ?? 'Unknown error.'}
        </div>
      )}

      {/* Where this org's mail goes right now. */}
      <section className="mt-6 rounded-xl border border-edge bg-paper p-6">
        <h2 className="text-[16px] font-semibold text-ink">Where your email goes</h2>
        <p className="mt-1 text-[13px] text-ink">
          {route?.via === 'org' && (
            <>Through your organization’s own server, from <span className="font-medium">{route.fromEmail}</span>.</>
          )}
          {route?.via === 'shared' && (
            <>
              Through the shared server, from <span className="font-medium">{route.fromEmail}</span>. Turn
              on your own server below to send from your own address.
            </>
          )}
          {!route && <>Nowhere yet — no server is set up, so no email is sent.</>}
        </p>

        <form action={sendTestEmail} className="mt-4 space-y-2 border-t border-edge pt-4">
          <label htmlFor="test-to" className="block text-[13px] font-medium text-ink">
            Send a test email to
          </label>
          <div className="flex flex-col gap-2 sm:flex-row">
            <input
              id="test-to"
              name="to"
              type="email"
              defaultValue={testedTo ?? ownEmail}
              placeholder={ownEmail || 'name@example.com'}
              autoComplete="email"
              className={fieldClass()}
            />
            <button
              type="submit"
              className="shrink-0 rounded-lg border border-edge-strong px-4 py-2 text-[13px] font-medium text-ink transition-colors hover:bg-shell"
            >
              Send test email
            </button>
          </div>
          <p className="text-[12px] text-muted">Leave blank to send it to yourself. Save first — the test uses the stored settings.</p>
        </form>
      </section>

      {/* This org's own server. */}
      <section className="mt-6 rounded-xl border border-edge bg-paper p-6">
        <h2 className="text-[16px] font-semibold text-ink">Your organization’s own server</h2>
        <p className="mb-4 mt-0.5 text-[13px] text-muted">
          Used only when it is turned on and has a host, port, and From email. While it is off, your
          email goes through the shared server.
        </p>
        <form action={saveEmailConfig} className="space-y-4">
          <SmtpFields cfg={orgCfg} enabledLabel="Send from our own SMTP server" />
          <button
            type="submit"
            className="rounded-lg bg-brand-primary px-4 py-2.5 text-[14px] font-medium text-white transition-colors hover:bg-brand-primary-dark"
          >
            Save
          </button>
        </form>
      </section>

      {/* The shared fallback server — platform admins only. */}
      {sharedCfg && (
        <section className="mt-6 rounded-xl border border-edge bg-paper p-6">
          <h2 className="text-[16px] font-semibold text-ink">Shared server</h2>
          <p className="mb-4 mt-0.5 text-[13px] text-muted">
            Platform admins only. Every organization without its own server sends through this one,
            from this From address.
          </p>
          <form action={saveSharedEmailConfig} className="space-y-4">
            <SmtpFields cfg={sharedCfg} enabledLabel="Enable the shared server" />
            <button
              type="submit"
              className="rounded-lg bg-brand-primary px-4 py-2.5 text-[14px] font-medium text-white transition-colors hover:bg-brand-primary-dark"
            >
              Save shared server
            </button>
          </form>
        </section>
      )}
    </div>
  )
}
