import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { auth } from '@/auth'
import { isPlatformAdmin } from '@/lib/auth-providers'
import { listOrganizations } from '@/server/platform/actions'
import { isEmailConfigured } from '@/lib/mailer'
import { OrganizationsManager } from './OrganizationsManager'

export const metadata: Metadata = { title: 'Organizations · Settings · Bevora Sign' }

export default async function OrganizationsSettingsPage() {
  const session = await auth()
  // Platform-admin ("IT admin") ONLY — everyone else (including an org owner)
  // gets a 404, no hint the page exists. This is the deployment super-admin
  // console, distinct from the per-org Settings → Team page. Both server actions
  // re-check this gate independently.
  if (!isPlatformAdmin(session)) notFound()

  // Cross-tenant list — gated the same way inside listOrganizations. Since we
  // already know the actor is a platform admin, ok is always true here.
  const [listed, emailConfigured] = await Promise.all([
    listOrganizations({ isPlatformAdmin: true }),
    isEmailConfigured(),
  ])
  const orgs = listed.ok ? listed.orgs : []

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6 lg:px-8">
      <div className="mb-2">
        <Link href="/documents" className="text-[13px] text-brand-primary hover:underline">
          ← Back to documents
        </Link>
      </div>
      <h1 className="text-[24px] font-semibold text-ink">Organizations</h1>
      <p className="mt-1 text-[14px] text-muted">
        Platform administration: create organizations (tenants) and provision users into any
        organization with any role. This is the only place that spans every organization — the
        per-org <span className="font-medium">Team</span> page stays scoped to a single org and
        adds members only.
      </p>

      <OrganizationsManager orgs={orgs} emailConfigured={emailConfigured} />
    </div>
  )
}
