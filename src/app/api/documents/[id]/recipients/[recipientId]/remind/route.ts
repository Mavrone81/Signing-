import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { prisma } from '@/lib/db'
import { canAccessDocument } from '@/lib/rbac'
import { notifyReminder } from '@/server/documents/notify'

// Sender-side, ORG-GATED manual reminder: re-send a pending recipient their
// signing link. Uses Prisma + the mailer (Node runtime), never cached.
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// POST /api/documents/[id]/recipients/[recipientId]/remind
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; recipientId: string }> },
) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'UNAUTHENTICATED' }, { status: 401 })
  }

  const { id, recipientId } = await params
  const doc = await prisma.document.findUnique({ where: { id } })
  if (!doc) {
    return NextResponse.json({ error: 'NOT_FOUND' }, { status: 404 })
  }
  // Tenancy: only the document's uploader, in its own org, may remind. A
  // cross-tenant caller gets 403 — never reaches the recipient.
  if (
    !canAccessDocument(
      { id: session.user.id, orgId: session.user.orgId, orgRole: session.user.orgRole },
      { ownerId: doc.ownerId, orgId: doc.orgId },
    )
  ) {
    return NextResponse.json({ error: 'FORBIDDEN' }, { status: 403 })
  }

  const base = new URL(req.url).origin
  const result = await notifyReminder(id, recipientId, base)

  if (result.sent) {
    return NextResponse.json({ sent: true }, { status: 200 })
  }
  if (result.reason === 'not_found') {
    // No such pending/viewed recipient on this document.
    return NextResponse.json({ error: 'RECIPIENT_NOT_PENDING' }, { status: 404 })
  }
  if (result.reason === 'not_configured') {
    // Email isn't set up — not an error, the UI shows the copy-link fallback.
    return NextResponse.json({ sent: false, reason: 'not_configured' }, { status: 200 })
  }
  // SMTP send failed.
  return NextResponse.json({ sent: false, reason: 'error' }, { status: 502 })
}
