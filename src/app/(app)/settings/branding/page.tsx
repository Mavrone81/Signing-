import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { auth } from '@/auth'
import { prisma } from '@/lib/db'
import { loadLogoDataUri, resolveBrand } from '@/lib/branding'
import { BrandingForm } from './BrandingForm'

export const metadata: Metadata = { title: 'Branding · Settings · Bevora Sign' }

// Org owner/admin only — branding is per-org, self-service. A plain member (or
// no membership) gets a 404 (no hint the page exists). NOT platform-admin gated.
export default async function BrandingSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ saved?: string; error?: string }>
}) {
  const session = await auth()
  const role = session?.user?.orgRole
  const orgId = session?.user?.orgId
  if (!orgId || (role !== 'owner' && role !== 'admin')) notFound()

  const org = await prisma.organization.findUnique({
    where: { id: orgId },
    select: { name: true, brandName: true, brandColor: true, logoKey: true },
  })
  if (!org) notFound()

  const brand = resolveBrand(org)
  // Inline the stored logo for the form's current-logo preview (org-gated read).
  const logoDataUri = await loadLogoDataUri(org.logoKey)

  const { saved, error } = await searchParams
  const errorMsg =
    error === 'type'
      ? 'That file type is not supported. Upload a PNG, JPG, or SVG.'
      : error === 'size'
        ? 'That logo is too large. The limit is 1 MB.'
        : error === 'empty'
          ? 'That file appears to be empty.'
          : null

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6 lg:px-8">
      <div className="mb-2">
        <Link href="/documents" className="text-[13px] text-brand-primary hover:underline">
          ← Back to documents
        </Link>
      </div>
      <h1 className="text-[24px] font-semibold text-ink">Branding</h1>
      <p className="mt-1 text-[14px] text-muted">
        White-label the signing experience for your organization. Your brand name, colour, and logo
        appear to the people you send documents to and in notification emails.
      </p>

      {saved && (
        <div className="mt-4 rounded-lg border border-brand-primary/30 bg-brand-primary/5 px-4 py-2.5 text-[13px] text-brand-primary-dark">
          Branding saved.
        </div>
      )}
      {errorMsg && (
        <div className="mt-4 rounded-lg border border-danger/30 bg-danger/5 px-4 py-2.5 text-[13px] text-danger">
          {errorMsg}
        </div>
      )}

      <BrandingForm
        orgName={org.name}
        initialBrandName={org.brandName ?? ''}
        initialBrandColor={brand.customized ? brand.color : null}
        initialLogo={logoDataUri}
      />
    </div>
  )
}
