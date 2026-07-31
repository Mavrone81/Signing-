import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { auth } from '@/auth'
import { listWebhooks, WEBHOOK_EVENTS } from '@/server/webhooks/actions'
import { WebhooksManager } from './WebhooksManager'
import { PageHeader } from '@/components/ui/PageHeader'

export const metadata: Metadata = { title: 'Webhooks · Settings · Bevora Sign' }

// Org owner/admin only — webhooks are per-org, self-service (like Branding).
export default async function WebhooksSettingsPage() {
  const session = await auth()
  const role = session?.user?.orgRole
  const orgId = session?.user?.orgId
  if (!orgId || (role !== 'owner' && role !== 'admin')) notFound()

  const webhooks = await listWebhooks(orgId)

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6 lg:px-8">
      <PageHeader
        title="Webhooks"
        backHref="/documents"
        subtitle={
          <>
            Receive a signed HTTP POST when signing events happen in your organization. Verify each delivery with the{' '}
            <code>X-BevoraSign-Signature: sha256=…</code> header (HMAC-SHA256 of the raw body using the endpoint’s secret).
          </>
        }
      />

      <WebhooksManager webhooks={webhooks} allEvents={[...WEBHOOK_EVENTS]} />
    </div>
  )
}
