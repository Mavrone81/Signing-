import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { auth } from '@/auth'
import {
  getProviderConfigsForClient,
  isPlatformAdmin,
  AUTHJS_PROVIDER_ID,
  type ProviderClientView,
} from '@/lib/auth-providers'
import { saveProviderConfig } from './actions'

export const metadata: Metadata = { title: 'Authentication · Settings · Bevora Sign' }

// Base URL used to display the exact redirect URIs the admin must register.
function callbackBase(): { base: string; isHttps: boolean; configured: boolean } {
  const raw = process.env.AUTH_URL?.replace(/\/+$/, '')
  if (!raw) return { base: 'https://<your-domain>', isHttps: false, configured: false }
  return { base: raw, isHttps: raw.startsWith('https://'), configured: true }
}

function fieldClass() {
  return 'w-full rounded-lg border border-edge-strong bg-paper px-3 py-2 text-[14px] text-ink outline-none focus:border-brand-primary focus:ring-1 focus:ring-brand-primary'
}

function ProviderCard({
  cfg,
  redirectUri,
  saved,
}: {
  cfg: ProviderClientView
  redirectUri: string
  saved: boolean
}) {
  const isMicrosoft = cfg.provider === 'microsoft'
  const label = isMicrosoft ? 'Microsoft (Entra ID)' : 'Google'

  return (
    <section className="rounded-xl border border-edge bg-paper p-6">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h2 className="text-[16px] font-semibold text-ink">{label}</h2>
          <p className="mt-0.5 text-[13px] text-muted">
            {cfg.enabled ? 'Enabled' : 'Disabled'}
            {' · '}
            {cfg.clientId && cfg.hasSecret
              ? 'Configured'
              : cfg.clientId || cfg.hasSecret
                ? 'Partially configured'
                : 'Not configured'}
          </p>
        </div>
        {saved && (
          <span className="rounded-full bg-green-50 px-2.5 py-1 text-[12px] font-medium text-brand-primary-dark">
            Saved
          </span>
        )}
      </div>

      {/* Redirect URI the admin registers with the provider. */}
      <div className="mb-4 rounded-lg bg-shell px-3 py-2.5">
        <div className="text-[12px] font-medium text-muted">Authorized redirect URI</div>
        <code className="mt-1 block break-all text-[12.5px] text-ink">{redirectUri}</code>
      </div>

      <form action={saveProviderConfig} className="space-y-4">
        <input type="hidden" name="provider" value={cfg.provider} />

        <div>
          <label className="mb-1.5 block text-[13px] font-medium text-ink">Client ID</label>
          <input
            name="clientId"
            type="text"
            defaultValue={cfg.clientId}
            placeholder="Client ID from the provider"
            autoComplete="off"
            className={fieldClass()}
          />
        </div>

        <div>
          <label className="mb-1.5 block text-[13px] font-medium text-ink">
            Client secret{' '}
            <span className="font-normal text-muted">
              {cfg.hasSecret ? '(a secret is stored — leave blank to keep it)' : '(write-only)'}
            </span>
          </label>
          <input
            name="clientSecret"
            type="password"
            placeholder={cfg.hasSecret ? '•••••••• stored' : 'Paste the client secret'}
            autoComplete="new-password"
            className={fieldClass()}
          />
        </div>

        {isMicrosoft && (
          <div>
            <label className="mb-1.5 block text-[13px] font-medium text-ink">
              Tenant ID <span className="font-normal text-muted">(default: common)</span>
            </label>
            <input
              name="tenantId"
              type="text"
              defaultValue={cfg.tenantId}
              placeholder="common"
              autoComplete="off"
              className={fieldClass()}
            />
            <p className="mt-1 text-[12px] text-muted">
              &quot;common&quot; allows any Microsoft account; a directory (tenant) GUID restricts
              sign-in to that organization.
            </p>
          </div>
        )}

        <label className="flex items-center gap-2.5">
          <input
            name="enabled"
            type="checkbox"
            defaultChecked={cfg.enabled}
            className="h-4 w-4 rounded border-edge-strong text-brand-primary focus:ring-brand-primary"
          />
          <span className="text-[13px] text-ink">
            Enable &quot;Sign in with {label}&quot;
          </span>
        </label>

        <button
          type="submit"
          className="rounded-lg bg-brand-primary px-4 py-2.5 text-[14px] font-medium text-white transition-colors hover:bg-brand-primary-dark"
        >
          Save {label}
        </button>
      </form>
    </section>
  )
}

export default async function AuthenticationSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ saved?: string; error?: string }>
}) {
  const session = await auth()
  // Platform-admin ("IT admin") only — everyone else gets a 404 (no hint the
  // page exists).
  if (!isPlatformAdmin(session)) notFound()

  const { saved } = await searchParams
  const configs = await getProviderConfigsForClient()
  const { base, isHttps, configured } = callbackBase()

  return (
    <div className="mx-auto max-w-2xl px-4 py-8 sm:px-6 lg:px-8">
      <div className="mb-2">
        <Link href="/documents" className="text-[13px] text-brand-primary hover:underline">
          ← Back to documents
        </Link>
      </div>
      <h1 className="text-[24px] font-semibold text-ink">Authentication</h1>
      <p className="mt-1 text-[14px] text-muted">
        Configure Google and Microsoft single sign-on for this deployment. Keys are stored
        encrypted; the client secret is never shown again after you save it.
      </p>

      {/* HTTPS caveat — the SSO round-trip cannot complete over plain HTTP. */}
      <div
        className={`mt-5 rounded-lg border px-4 py-3 text-[13px] ${
          isHttps
            ? 'border-edge bg-shell text-ink'
            : 'border-amber-300 bg-amber-50 text-amber-900'
        }`}
      >
        <strong>SSO requires HTTPS.</strong> Google and Microsoft reject non-HTTPS redirect URIs
        (only <code>http://localhost</code> is allowed). These logins activate once the app is
        served over <code>https</code> with a real domain and <code>AUTH_URL</code> is set to it.
        {configured ? (
          <>
            {' '}
            Current <code>AUTH_URL</code>: <code className="break-all">{base}</code>
            {!isHttps && ' — not https, so SSO will not complete yet.'}
          </>
        ) : (
          <>
            {' '}
            <code>AUTH_URL</code> is not set — the redirect URIs below use a placeholder domain.
          </>
        )}
      </div>

      <div className="mt-6 space-y-6">
        <ProviderCard
          cfg={configs.google}
          redirectUri={`${base}/api/auth/callback/${AUTHJS_PROVIDER_ID.google}`}
          saved={saved === 'google'}
        />
        <ProviderCard
          cfg={configs.microsoft}
          redirectUri={`${base}/api/auth/callback/${AUTHJS_PROVIDER_ID.microsoft}`}
          saved={saved === 'microsoft'}
        />
      </div>
    </div>
  )
}
