import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { auth } from '@/auth'
import { listWebhooks, WEBHOOK_EVENTS } from '@/server/webhooks/actions'
import { WebhooksManager } from './WebhooksManager'

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
      <div className="mb-2">
        <Link href="/documents" className="text-[13px] text-brand-primary hover:underline">
          ← Back to documents
        </Link>
      </div>
      <h1 className="text-[24px] font-semibold text-ink">Webhooks</h1>
      <p className="mt-1 text-[14px] text-muted">
        Receive a signed HTTP POST when signing events happen in your organization. Verify each delivery with the{' '}
        <code>X-BevoraSign-Signature: sha256=…</code> header (HMAC-SHA256 of the raw body using the endpoint’s secret).
      </p>

      <WebhooksManager webhooks={webhooks} allEvents={[...WEBHOOK_EVENTS]} />
    </div>
  )
}
