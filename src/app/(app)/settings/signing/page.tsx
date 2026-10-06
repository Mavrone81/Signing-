import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { auth } from '@/auth'
import { prisma } from '@/lib/db'
import { canManageOrgSettings } from '@/lib/org-settings'
import { getSigningConfigForClient, EXPIRY_WARNING_DAYS } from '@/lib/signing-config'
import {
  generatePlatformCertificate,
  uploadPlatformCertificate,
  saveTsaUrl,
  removePlatformCertificate,
} from './actions'
import { PageHeader } from '@/components/ui/PageHeader'

export const metadata: Metadata = { title: 'Signing · Settings · Bevora Sign' }

function fieldClass() {
  return 'w-full rounded-lg border border-edge-strong bg-paper px-3 py-2 text-[14px] text-ink outline-none focus:border-brand-primary focus:ring-1 focus:ring-brand-primary'
}

const DATE_FMT = new Intl.DateTimeFormat('en-SG', {
  timeZone: 'Asia/Singapore',
  dateStyle: 'medium',
})

export default async function SigningSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ saved?: string; error?: string }>
}) {
  const session = await auth()
  // The org's owners/admins (and platform admins) only — everyone else, and
  // anyone with no org, gets a 404 (no hint the page exists). The write actions
  // re-check this gate independently and take the org from the session.
  const user = session?.user
  if (!canManageOrgSettings(user)) notFound()

  const { saved, error } = await searchParams
  const cfg = await getSigningConfigForClient(user.orgId)
  // The CN is the name a recipient sees in their PDF reader's signature
  // panel, so it defaults to this organization rather than the product.
  const org = await prisma.organization.findUnique({ where: { id: user.orgId }, select: { name: true } })
  const defaultSignerName = org?.name?.trim() || 'Bevora Sign'
  const configured = cfg?.configured === true

  return (
    <div className="mx-auto max-w-2xl px-4 py-8 sm:px-6 lg:px-8">
      <PageHeader
        title="Digital signing (PAdES / PKI)"
        backHref="/documents"
        subtitle={
          <>
            Configure your organization&apos;s signing certificate. When set, every document your
            organization completes is sealed with a PAdES-compliant digital signature (detached CMS, <code>ETSI.CAdES.detached</code>,
            whole-file ByteRange) so the final PDF is tamper-evident and verifiable in Adobe Reader.
            Until a certificate is configured, documents are finalized exactly as before (no seal).
            Each organization seals only with its own certificate. The private key and passphrase are
            stored encrypted and are never shown again.
          </>
        }
      />

      {saved && (
        <div className="mt-5 rounded-lg border border-edge bg-shell px-4 py-3 text-[13px] text-ink">
          {saved === 'generated' && 'Self-signed certificate generated and activated.'}
          {saved === 'uploaded' && 'Certificate uploaded and activated.'}
          {saved === 'tsa' && 'Timestamp (TSA) URL saved.'}
          {saved === 'removed' && 'Signing certificate removed. Documents finalize without a seal.'}
        </div>
      )}
      {error && (
        <div className="mt-5 rounded-lg border border-danger/35 bg-danger-tint px-4 py-3 text-[13px] text-ink">
          {error === 'nofile' && 'Please choose a .p12/.pfx file.'}
          {error === 'toolarge' && 'That file is too large to be a signing certificate.'}
          {error === 'badp12' && 'Could not open the P12 — check the file and passphrase.'}
          {error === 'notconfigured' && 'Configure a certificate first.'}
          {error === 'expired' && 'That certificate has already expired. Upload or generate one that is still valid.'}
          {error === 'notyetvalid' && 'That certificate is not valid yet (its validity period starts in the future). Upload or generate one that is valid now.'}
        </div>
      )}

      {/* Expiry warning — PASSIVE: only an admin who visits this page sees it.
          This is explicitly NOT a complete warning mechanism (F1b open item):
          a real warning needs a PUSH (email, in-app banner, alarm), and which
          of those to build is a product decision, not made here. */}
      {configured && !cfg!.expired && cfg!.daysUntilExpiry <= EXPIRY_WARNING_DAYS && (
        <div className="mt-5 rounded-lg border border-warn/35 bg-warn-tint px-4 py-3 text-[13px] text-ink">
          <strong>Certificate expiring soon.</strong> This certificate expires in{' '}
          {cfg!.daysUntilExpiry} day{cfg!.daysUntilExpiry === 1 ? '' : 's'}. Once it expires,
          this organization&apos;s documents will stop completing until a new certificate is
          generated or uploaded. Replace it before then.
        </div>
      )}

      {/* Adobe trust caveat — a self-signed seal is tamper-evident but not chained
          to a public CA, so Adobe shows "signature validity unknown" until the
          certificate is added to the reader's trusted identities. */}
      <div className="mt-5 rounded-lg border border-warn/35 bg-warn-tint px-4 py-3 text-[13px] text-ink">
        <strong>About trust in Adobe.</strong> A self-signed certificate makes the PDF
        tamper-evident and cryptographically verifiable, but Adobe Reader will show{' '}
        <em>&quot;signature validity is unknown&quot;</em> until the certificate is added to the
        reader&apos;s Trusted Certificates. Upload a P12 issued by a CA your recipients already
        trust to get a green check without that step.
      </div>

      {/* Current certificate */}
      <section className="mt-6 rounded-xl border border-edge bg-paper p-6">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-[16px] font-semibold text-ink">Active certificate</h2>
          <span
            className={`rounded-full px-2.5 py-1 text-[12px] font-medium ${
              configured
                ? cfg!.expired
                  ? 'bg-danger/10 text-danger'
                  : 'bg-good/10 text-good'
                : 'bg-shell text-muted'
            }`}
          >
            {configured ? (cfg!.expired ? 'Expired' : 'Active') : 'Not configured'}
          </span>
        </div>
        {configured ? (
          <>
            <dl className="grid grid-cols-1 gap-2 text-[13px] sm:grid-cols-[160px_1fr]">
              <dt className="text-muted">Subject</dt>
              <dd className="break-all text-ink">{cfg!.subject}</dd>
              <dt className="text-muted">Issuer</dt>
              <dd className="break-all text-ink">{cfg!.issuer}</dd>
              <dt className="text-muted">Valid</dt>
              <dd className="text-ink">
                {DATE_FMT.format(new Date(cfg!.notBefore!))} – {DATE_FMT.format(new Date(cfg!.notAfter!))}
              </dd>
              <dt className="text-muted">SHA-256 fingerprint</dt>
              <dd className="break-all font-mono text-[12px] text-ink">{cfg!.fingerprint}</dd>
              <dt className="text-muted">Origin</dt>
              <dd className="text-ink">{cfg!.origin === 'self-signed' ? 'Self-signed (generated in-app)' : 'Uploaded P12'}</dd>
              <dt className="text-muted">Timestamp (TSA)</dt>
              <dd className="break-all text-ink">{cfg!.tsaUrl || 'None'}</dd>
            </dl>

            {/* TSA URL update */}
            <form action={saveTsaUrl} className="mt-5 space-y-2 border-t border-edge pt-4">
              <label className="block text-[13px] font-medium text-ink">RFC-3161 Timestamp URL</label>
              <input
                name="tsaUrl"
                type="url"
                defaultValue={cfg!.tsaUrl}
                placeholder="http://timestamp.digicert.com"
                autoComplete="off"
                className={fieldClass()}
              />
              <p className="text-[12px] text-muted">
                Optional. When reachable, a trusted timestamp is embedded (PAdES-T). If the TSA is
                unreachable at signing time, the document is still sealed without the timestamp.
              </p>
              <button
                type="submit"
                className="rounded-lg bg-brand-primary px-4 py-2 text-[13px] font-medium text-white hover:bg-brand-primary-dark"
              >
                Save timestamp URL
              </button>
            </form>

            <form action={removePlatformCertificate} className="mt-4 border-t border-edge pt-4">
              <button
                type="submit"
                className="rounded-lg border border-danger/40 px-4 py-2 text-[13px] font-medium text-danger hover:bg-danger-tint"
              >
                Remove certificate (stop sealing)
              </button>
            </form>
          </>
        ) : (
          <p className="text-[13px] text-muted">
            Your organization has no signing certificate. Generate a self-signed certificate or
            upload a P12 below to start sealing its completed documents.
          </p>
        )}
      </section>

      {/* Generate self-signed */}
      <section className="mt-6 rounded-xl border border-edge bg-paper p-6">
        <h2 className="text-[16px] font-semibold text-ink">Generate self-signed certificate</h2>
        <p className="mt-0.5 text-[13px] text-muted">
          Creates an RSA-2048 key and self-signed X.509 certificate. Fastest way to start; the key
          never leaves the server.
        </p>
        <form action={generatePlatformCertificate} className="mt-4 space-y-4">
          <div>
            <label className="mb-1.5 block text-[13px] font-medium text-ink">
              Signer name (certificate CN)
            </label>
            <input name="commonName" type="text" defaultValue={defaultSignerName} className={fieldClass()} />
            <p className="mt-1 text-[12px] text-muted">
              Shown to recipients in their PDF reader&apos;s signature panel. Defaults to your
              organization&apos;s name.
            </p>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="mb-1.5 block text-[13px] font-medium text-ink">Validity (years)</label>
              <input name="years" type="number" min={1} max={30} defaultValue={3} className={fieldClass()} />
            </div>
            <div>
              <label className="mb-1.5 block text-[13px] font-medium text-ink">
                Timestamp URL <span className="font-normal text-muted">(optional)</span>
              </label>
              <input name="tsaUrl" type="url" placeholder="http://timestamp.digicert.com" className={fieldClass()} />
            </div>
          </div>
          <button
            type="submit"
            className="rounded-lg bg-brand-primary px-4 py-2.5 text-[14px] font-medium text-white hover:bg-brand-primary-dark"
          >
            Generate self-signed certificate
          </button>
        </form>
      </section>

      {/* Upload P12 */}
      <section className="mt-6 rounded-xl border border-edge bg-paper p-6">
        <h2 className="text-[16px] font-semibold text-ink">Upload a certificate (PKCS#12)</h2>
        <p className="mt-0.5 text-[13px] text-muted">
          Upload a <code>.p12</code>/<code>.pfx</code> containing the private key + certificate
          chain. Use a CA-issued certificate for signatures that Adobe trusts out of the box.
        </p>
        <form action={uploadPlatformCertificate} className="mt-4 space-y-4">
          <div>
            <label className="mb-1.5 block text-[13px] font-medium text-ink">P12 / PFX file</label>
            <input
              name="p12"
              type="file"
              accept=".p12,.pfx,application/x-pkcs12"
              className="block w-full text-[13px] text-ink file:mr-3 file:rounded-lg file:border-0 file:bg-shell file:px-3 file:py-2 file:text-[13px] file:font-medium file:text-ink"
            />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="mb-1.5 block text-[13px] font-medium text-ink">Passphrase</label>
              <input name="passphrase" type="password" autoComplete="new-password" className={fieldClass()} />
            </div>
            <div>
              <label className="mb-1.5 block text-[13px] font-medium text-ink">
                Timestamp URL <span className="font-normal text-muted">(optional)</span>
              </label>
              <input name="tsaUrl" type="url" placeholder="http://timestamp.digicert.com" className={fieldClass()} />
            </div>
          </div>
          <button
            type="submit"
            className="rounded-lg bg-brand-primary px-4 py-2.5 text-[14px] font-medium text-white hover:bg-brand-primary-dark"
          >
            Upload and activate
          </button>
        </form>
      </section>
    </div>
  )
}
