import type { Metadata } from 'next'
import Link from 'next/link'
import { getSignerEnvelope } from '@/server/envelopes/actions'

export const metadata: Metadata = { title: 'Documents to sign · Bevora Sign' }

// PUBLIC (unauthenticated) page for one envelope signer. Authorization is the
// unguessable token in the path; it only ever reveals that signer's own
// per-document links, each of which goes through the unchanged /sign/<token>
// flow with its own checks. Per-request DB read — never prerendered.
export const dynamic = 'force-dynamic'

const STATE: Record<string, { label: string; tone: string; action: boolean }> = {
  pending: { label: 'To sign', tone: 'bg-warn-tint text-ink', action: true },
  viewed: { label: 'To sign', tone: 'bg-warn-tint text-ink', action: true },
  signed: { label: 'Signed', tone: 'bg-good-tint text-ink', action: false },
  declined: { label: 'Declined', tone: 'bg-shell text-muted', action: false },
}

export default async function EnvelopeSignerPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const view = await getSignerEnvelope(token)

  if (!view) {
    return (
      <div className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center px-6 text-center">
        <h1 className="text-[20px] font-semibold text-ink">This link is no longer active</h1>
        <p className="mt-2 text-[14px] text-muted">The link is invalid or has expired. Please ask the sender for a new one.</p>
      </div>
    )
  }

  const toSign = view.documents.filter((d) => d.recipientStatus === 'pending' || d.recipientStatus === 'viewed').length

  return (
    <main className="min-h-screen bg-shell px-4 py-10">
      <div className="mx-auto max-w-xl">
        <h1 className="text-[22px] font-semibold text-ink">{view.envelopeName}</h1>
        <p className="mt-1 text-[14px] text-muted">
          Hi {view.signerName}. {view.senderName} has asked you to sign{' '}
          {view.documents.length === 1 ? 'this document' : `these ${view.documents.length} documents`}.
          {toSign === 0 && view.documents.length > 0 ? ' You’re all done — thank you.' : ''}
        </p>

        {view.documents.length === 0 ? (
          <p className="mt-6 rounded-xl border border-edge bg-paper p-5 text-[14px] text-muted">
            Nothing has been sent to you yet.
          </p>
        ) : (
          <ul className="mt-6 divide-y divide-edge overflow-hidden rounded-xl border border-edge bg-paper">
            {view.documents.map((d, i) => {
              const s = STATE[d.recipientStatus ?? ''] ?? { label: d.documentStatus, tone: 'bg-shell text-muted', action: false }
              const open = s.action && d.documentStatus === 'sent' && d.signToken
              return (
                <li key={i} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3.5">
                  <div className="min-w-0">
                    <p className="truncate text-[14px] font-medium text-ink">{d.name}</p>
                    <span className={`mt-1 inline-block rounded-full px-2 py-0.5 text-[12px] font-medium ${s.tone}`}>{s.label}</span>
                  </div>
                  {open ? (
                    <Link
                      href={`/sign/${d.signToken}`}
                      className="min-h-11 rounded-lg bg-brand-primary px-4 py-2.5 text-[14px] font-medium text-white hover:bg-brand-primary-dark"
                    >
                      Review &amp; sign
                    </Link>
                  ) : null}
                </li>
              )
            })}
          </ul>
        )}
        <p className="mt-4 text-[12px] text-muted">Keep this page: it always lists where each of your documents stands.</p>
      </div>
    </main>
  )
}
