import type { Metadata } from 'next'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { auth } from '@/auth'
import { prisma } from '@/lib/db'
import { listEnvelopes } from '@/server/envelopes/actions'
import { PageHeader } from '@/components/ui/PageHeader'
import { EnvelopeStatusPill } from '@/components/envelopes/EnvelopeStatusPill'
import { NewEnvelopeForm } from './NewEnvelopeForm'

export const metadata: Metadata = { title: 'Envelopes · Bevora Sign' }
export const dynamic = 'force-dynamic'

export default async function EnvelopesPage() {
  const session = await auth()
  if (!session?.user?.id) redirect('/login')
  const actor = { id: session.user.id, orgId: session.user.orgId ?? null, orgRole: session.user.orgRole ?? null }

  const [envelopes, drafts] = await Promise.all([
    listEnvelopes(actor),
    // The caller's own drafts that aren't in an envelope yet (owner-only, like
    // every document listing).
    actor.orgId
      ? prisma.document.findMany({
          where: { orgId: actor.orgId, ownerId: actor.id, status: 'draft', envelopeId: null },
          orderBy: { createdAt: 'desc' },
          select: { id: true, originalName: true },
        })
      : Promise.resolve([]),
  ])

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6 lg:px-8">
      <PageHeader
        title="Envelopes"
        subtitle="Send several documents to the same people at once. Each signer gets one email and one link for all of them."
      />

      <NewEnvelopeForm drafts={drafts.map((d) => ({ id: d.id, name: d.originalName }))} />

      <h2 className="mb-2 mt-8 text-[15px] font-semibold text-ink">Your envelopes</h2>
      {envelopes.length === 0 ? (
        <p className="rounded-xl border border-edge bg-paper p-5 text-[14px] text-muted">No envelopes yet.</p>
      ) : (
        <ul className="divide-y divide-edge overflow-hidden rounded-xl border border-edge bg-paper">
          {envelopes.map((e) => (
            <li key={e.id}>
              <Link href={`/envelopes/${e.id}`} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3.5 hover:bg-shell">
                <span className="min-w-0">
                  <span className="block truncate text-[14px] font-medium text-ink">{e.name}</span>
                  <span className="text-[12px] text-muted">
                    {e.documentCount} document{e.documentCount === 1 ? '' : 's'} · {e.signerCount} signer
                    {e.signerCount === 1 ? '' : 's'}
                  </span>
                </span>
                <EnvelopeStatusPill status={e.status} />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
