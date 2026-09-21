import type { Metadata } from 'next'
import { notFound, redirect } from 'next/navigation'
import { auth } from '@/auth'
import { prisma } from '@/lib/db'
import { canAccessDocument } from '@/lib/rbac'
import { Editor, type SenderRecipient } from '@/components/pdf-editor/Editor'
import type { FlatField, SigningOrder, TextStyle } from '@/components/pdf-editor/types'

// The canonical base URL for signing links shown to the sender. Mirrors the
// /send route: AUTH_URL when set (the eventual HTTPS host), else relative links
// (the browser resolves them against the current origin).
function signingUrl(token: string): string {
  const base = (process.env.AUTH_URL ?? '').replace(/\/$/, '')
  return `${base}/sign/${token}`
}

const SENT_STATUSES = new Set(['sent', 'completed', 'declined'])

export const metadata: Metadata = { title: 'Edit · Bevora Sign' }

// Reads the doc + its fields from Prisma per-request and gates on RBAC, so it
// must be force-dynamic (never prerendered at build time).
export const dynamic = 'force-dynamic'

export default async function EditDocumentPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const session = await auth()
  if (!session?.user?.id) redirect('/login')

  const { id } = await params
  const doc = await prisma.document.findUnique({
    where: { id },
    include: { fields: true, recipients: { orderBy: { orderIndex: 'asc' } } },
  })
  if (!doc) notFound()

  // 404 (not 403) for docs the user can't access — don't leak existence.
  if (
    !canAccessDocument(
      { id: session.user.id, orgId: session.user.orgId, orgRole: session.user.orgRole },
      { ownerId: doc.ownerId, orgId: doc.orgId },
    )
  ) {
    notFound()
  }

  const initialFields: FlatField[] = doc.fields.map((f) => ({
    page: f.page,
    type: f.type,
    x: f.x,
    y: f.y,
    w: f.w,
    h: f.h,
    value: f.value,
    style: f.type === 'text' ? ((f.style as unknown as TextStyle | null) ?? undefined) : undefined,
    recipientId: f.recipientId,
  }))

  // Only expose signing tokens/links once the document has actually been sent —
  // a draft's tokens are placeholders, and links should not leak pre-send.
  const isSent = SENT_STATUSES.has(doc.status)
  const initialRecipients: SenderRecipient[] = doc.recipients.map((r) => ({
    id: r.id,
    name: r.name,
    email: r.email,
    status: r.status,
    signingUrl: isSent ? signingUrl(r.token) : null,
  }))

  return (
    <Editor
      documentId={doc.id}
      originalName={doc.originalName}
      status={doc.status}
      initialFields={initialFields}
      initialRecipients={initialRecipients}
      initialSigningOrder={doc.signingOrder as SigningOrder}
      initialInviteMessage={doc.inviteMessage}
    />
  )
}
