import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { auth } from '@/auth'
import { isPlatformAdmin } from '@/lib/auth-providers'
import { getEmailConfigForClient } from '@/lib/email-config'
import { saveEmailConfig, sendTestEmail } from './actions'
import { PageHeader } from '@/components/ui/PageHeader'

export const metadata: Metadata = { title: 'Email · Settings · Bevora Sign' }

function fieldClass() {
  return 'w-full rounded-lg border border-edge-strong bg-paper px-3 py-2 text-[14px] text-ink outline-none focus:border-brand-primary focus:ring-1 focus:ring-brand-primary'
}

const TEST_REASON: Record<string, string> = {
  not_configured: 'Email is not enabled/configured yet — fill in and save the SMTP settings first.',
  error: 'The SMTP server rejected or failed the send. Check the host, port, credentials, and TLS setting.',
  no_admin_email: 'Your account has no email address to send the test to.',
}

export default async function EmailSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ saved?: string; error?: string; test?: string; reason?: string }>
}) {
  const session = await auth()
  // Platform-admin ("IT admin") only — everyone else gets a 404 (no hint the
  // page exists), same as Settings → Authentication.
  if (!isPlatformAdmin(session)) notFound()

  const { saved, error, test, reason } = await searchParams
  const cfg = await getEmailConfigForClient()
  const adminEmail = session!.user.email

  return (
    <div className="mx-auto max-w-2xl px-4 py-8 sm:px-6 lg:px-8">
      <PageHeader
        title="Email"
        backHref="/documents"
        subtitle={
          <>
            Configure the outbound SMTP server used to email signing invitations, reminders, and
            completed/declined notices. The password is stored encrypted and is never shown again after
            you save it.
          </>
        }
      />

      {saved && (
        <div className="mt-5 rounded-lg border border-edge bg-shell px-4 py-3 text-[13px] text-ink">
          Email settings saved.
        </div>
      )}
      {error === 'port' && (
        <div className="mt-5 rounded-lg border border-warn/35 bg-warn-tint px-4 py-3 text-[13px] text-ink">
          Port must be a number between 1 and 65535.
        </div>
      )}
      {test === 'ok' && (
        <div className="mt-5 rounded-lg border border-edge bg-brand-primary-tint px-4 py-3 text-[13px] text-brand-primary-dark">
          Test email sent to {adminEmail}. Check your inbox.
        </div>
      )}
      {test === 'fail' && (
        <div className="mt-5 rounded-lg border border-warn/35 bg-warn-tint px-4 py-3 text-[13px] text-ink">
          Test email failed. {TEST_REASON[reason ?? ''] ?? 'Unknown error.'}
        </div>
      )}

      <section className="mt-6 rounded-xl border border-edge bg-paper p-6">
        <div className="mb-4 flex items-center justify-between">
          <div>
            <h2 className="text-[16px] font-semibold text-ink">SMTP</h2>
            <p className="mt-0.5 text-[13px] text-muted">
              {cfg.enabled ? 'Enabled' : 'Disabled'}
              {' · '}
              {cfg.host && cfg.port && cfg.fromEmail ? 'Configured' : 'Not fully configured'}
            </p>
          </div>
        </div>

        <form action={saveEmailConfig} className="space-y-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <div className="sm:col-span-2">
              <label className="mb-1.5 block text-[13px] font-medium text-ink">SMTP host</label>
              <input
                name="host"
                type="text"
                defaultValue={cfg.host}
                placeholder="smtp.example.com"
                autoComplete="off"
                className={fieldClass()}
              />
            </div>
            <div>
              <label className="mb-1.5 block text-[13px] font-medium text-ink">Port</label>
              <input
                name="port"
                type="number"
                min={1}
                max={65535}
                defaultValue={cfg.port}
                placeholder="587"
                autoComplete="off"
                className={fieldClass()}
              />
            </div>
          </div>

          <label className="flex items-center gap-2.5">
            <input
              name="secure"
              type="checkbox"
              defaultChecked={cfg.secure}
              className="h-4 w-4 rounded border-edge-strong text-brand-primary focus:ring-brand-primary"
            />
            <span className="text-[13px] text-ink">
              Use TLS (SSL) — on for port 465; off for 587/STARTTLS
            </span>
          </label>

          <div>
            <label className="mb-1.5 block text-[13px] font-medium text-ink">Username</label>
            <input
              name="username"
              type="text"
              defaultValue={cfg.username}
              placeholder="SMTP username (optional for open relays)"
              autoComplete="off"
              className={fieldClass()}
            />
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
              <input
                name="fromName"
                type="text"
                defaultValue={cfg.fromName}
                placeholder="Bevora Sign"
                autoComplete="off"
                className={fieldClass()}
              />
            </div>
            <div>
              <label className="mb-1.5 block text-[13px] font-medium text-ink">From email</label>
              <input
                name="fromEmail"
                type="email"
                defaultValue={cfg.fromEmail}
                placeholder="no-reply@example.com"
                autoComplete="off"
                className={fieldClass()}
              />
            </div>
          </div>

          <label className="flex items-center gap-2.5">
            <input
              name="enabled"
              type="checkbox"
              defaultChecked={cfg.enabled}
              className="h-4 w-4 rounded border-edge-strong text-brand-primary focus:ring-brand-primary"
            />
            <span className="text-[13px] text-ink">
              Enable outbound email (signing invitations, reminders, completed/declined notices)
            </span>
          </label>

          <button
            type="submit"
            className="rounded-lg bg-brand-primary px-4 py-2.5 text-[14px] font-medium text-white transition-colors hover:bg-brand-primary-dark"
          >
            Save email settings
          </button>
        </form>

        <div className="mt-6 border-t border-edge pt-5">
          <p className="mb-3 text-[13px] text-muted">
            Send a test email to <span className="font-medium text-ink">{adminEmail}</span> to verify
            your settings. Save first — the test uses the stored configuration.
          </p>
          <form action={sendTestEmail}>
            <button
              type="submit"
              className="rounded-lg border border-edge-strong px-4 py-2.5 text-[14px] font-medium text-ink transition-colors hover:bg-shell"
            >
              Send test email
            </button>
          </form>
        </div>
      </section>
    </div>
  )
}
