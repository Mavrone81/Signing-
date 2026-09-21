import type { Metadata } from 'next'
import Link from 'next/link'
import { headers } from 'next/headers'
import { notFound, redirect } from 'next/navigation'
import { auth } from '@/auth'
import { prisma } from '@/lib/db'
import { env } from '@/env'
import { getEnvelope } from '@/server/envelopes/actions'
import { DEFAULT_INVITE_MESSAGE } from '@/lib/invite-message'
import { PageHeader } from '@/components/ui/PageHeader'
import { StatusPill } from '@/components/ui/StatusPill'
import { EnvelopeStatusPill } from '@/components/envelopes/EnvelopeStatusPill'
import { addDocumentsAction, removeDocumentAction } from '../actions'
import { EnvelopeManager } from './EnvelopeManager'

export const metadata: Metadata = { title: 'Envelope · Bevora Sign' }
export const dynamic = 'force-dynamic'

const NOT_READY: Record<string, string> = {
  NO_RECIPIENTS: 'No signers yet',
  RECIPIENT_WITHOUT_FIELD: 'A signer has no field — open it to place one',
}

export default async function EnvelopePage({ params }: { params: Promise<{ id: string }> }) {
  const session = await auth()
  if (!session?.user?.id) redirect('/login')
  const actor = { id: session.user.id, orgId: session.user.orgId ?? null, orgRole: session.user.orgRole ?? null }

  const { id } = await params
  // Owner-only: anyone else gets a 404, not a hint that it exists.
  const view = await getEnvelope(actor, id)
  if (!view) notFound()

  const addable = actor.orgId
    ? await prisma.document.findMany({
        where: { orgId: actor.orgId, ownerId: actor.id, status: 'draft', envelopeId: null },
        orderBy: { createdAt: 'desc' },
        select: { id: true, originalName: true },
      })
    : []
  // Absolute links to copy: the configured public URL, else this request's origin.
  const h = await headers()
  const host = h.get('x-forwarded-host') ?? h.get('host')
  const origin = host ? `${h.get('x-forwarded-proto') ?? 'http'}://${host}` : ''
  const base = (env.AUTH_URL ?? origin).replace(/\/+$/, '')
  const anySent = view.documents.some((d) => d.status !== 'draft')

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6 lg:px-8">
      <PageHeader title={view.name} backHref="/envelopes" backLabel="Back to envelopes">
        <EnvelopeStatusPill status={view.status} />
      </PageHeader>

      <section className="rounded-xl border border-edge bg-paper p-5">
        <h2 className="text-[15px] font-semibold text-ink">Documents</h2>
        <p className="mt-0.5 text-[13px] text-muted">
          Each document keeps its own fields and signing. Open one to place fields for each signer.
        </p>
        <ul className="mt-3 divide-y divide-edge">
          {view.documents.map((d) => (
            <li key={d.id} className="flex flex-wrap items-center justify-between gap-3 py-2.5">
              <div className="min-w-0">
                <Link href={`/documents/${d.id}/edit`} className="block truncate text-[14px] font-medium text-ink hover:text-brand-primary">
                  {d.name}
                </Link>
                {d.notReady && (
                  <span className="mt-0.5 flex items-center gap-1.5 text-[12px] text-ink">
                    <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-warn" aria-hidden />
                    {NOT_READY[d.notReady]}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-3">
                <StatusPill status={d.status} />
                {d.status === 'draft' && (
                  <form action={removeDocumentAction}>
                    <input type="hidden" name="envelopeId" value={view.id} />
                    <input type="hidden" name="documentId" value={d.id} />
                    <button type="submit" className="text-[13px] font-medium text-muted hover:text-danger">
                      Remove
                    </button>
                  </form>
                )}
              </div>
            </li>
          ))}
          {view.documents.length === 0 && <li className="py-2.5 text-[13px] text-muted">No documents in this envelope.</li>}
        </ul>

        {addable.length > 0 && (
          <form action={addDocumentsAction} className="mt-4 border-t border-edge pt-4">
            <input type="hidden" name="envelopeId" value={view.id} />
            <p className="mb-1.5 text-[13px] font-medium text-ink">Add drafts</p>
            <div className="max-h-44 space-y-1.5 overflow-y-auto">
              {addable.map((d) => (
                <label key={d.id} className="flex items-center gap-2.5 text-[13px] text-ink">
                  <input type="checkbox" name="documentId" value={d.id} className="h-4 w-4 rounded border-edge-strong text-brand-primary" />
                  <span className="truncate">{d.originalName}</span>
                </label>
              ))}
            </div>
            <button type="submit" className="mt-2 rounded-lg border border-edge-strong px-3 py-1.5 text-[13px] font-medium text-ink hover:bg-shell">
              Add selected
            </button>
          </form>
        )}
      </section>

      <EnvelopeManager
        envelopeId={view.id}
        signers={view.signers.map((s) => ({ name: s.name, email: s.email, link: `${base}/e/${s.token}` }))}
        initialMessage={view.inviteMessage ?? DEFAULT_INVITE_MESSAGE}
        showLinks={anySent}
        hasDrafts={view.documents.some((d) => d.status === 'draft')}
      />
    </div>
  )
}
