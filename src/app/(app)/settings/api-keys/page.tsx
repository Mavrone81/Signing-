import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { auth } from '@/auth'
import { listApiKeys } from '@/server/api-keys/actions'
import { ApiKeysManager } from './ApiKeysManager'
import { PageHeader } from '@/components/ui/PageHeader'

export const metadata: Metadata = { title: 'API keys · Settings · Bevora Sign' }

// Org owner/admin only — API keys are per-org, self-service (like Branding). A
// plain member (or no membership) gets a 404 (no hint the page exists).
export default async function ApiKeysSettingsPage() {
  const session = await auth()
  const role = session?.user?.orgRole
  const orgId = session?.user?.orgId
  if (!orgId || (role !== 'owner' && role !== 'admin')) notFound()

  const keys = await listApiKeys(orgId)

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6 lg:px-8">
      <PageHeader
        title="API keys"
        backHref="/documents"
        subtitle={
          <>
            Programmatic access to the Bevora Sign REST API (<code>/api/v1</code>). Authenticate requests with{' '}
            <code>Authorization: Bearer sk_live_…</code>. Each key acts only within this organization.
          </>
        }
      />

      <ApiKeysManager keys={keys} />
    </div>
  )
}
