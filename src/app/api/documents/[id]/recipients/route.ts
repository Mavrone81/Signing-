import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { prisma } from '@/lib/db'
import { canAccessDocument } from '@/lib/rbac'
import { saveRecipients, type RecipientInput } from '@/server/documents/actions'

// Persists recipients via Prisma (native Node APIs) under per-request auth —
// must run on the Node runtime and never be statically cached.
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// PUT /api/documents/[id]/recipients — replace the document's recipient list
// (replace-all, like /fields). Body: `{ recipients: RecipientInput[] }`.
export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'UNAUTHENTICATED' }, { status: 401 })
  }

  const { id } = await params
  const doc = await prisma.document.findUnique({ where: { id } })
  if (!doc) {
    return NextResponse.json({ error: 'NOT_FOUND' }, { status: 404 })
  }
  if (
    !canAccessDocument(
      { id: session.user.id, orgId: session.user.orgId, orgRole: session.user.orgRole },
      { ownerId: doc.ownerId, orgId: doc.orgId },
    )
  ) {
    return NextResponse.json({ error: 'FORBIDDEN' }, { status: 403 })
  }

  let recipients: RecipientInput[]
  let signingOrder: 'parallel' | 'sequential' | undefined
  try {
    const body = await req.json()
    recipients = body.recipients
    if (!Array.isArray(recipients)) throw new Error('bad body')
    signingOrder =
      body.signingOrder === 'parallel' || body.signingOrder === 'sequential'
        ? body.signingOrder
        : undefined
  } catch {
    return NextResponse.json({ error: 'INVALID_REQUEST' }, { status: 400 })
  }

  try {
    const saved = await saveRecipients(id, recipients, { signingOrder })
    return NextResponse.json({ recipients: saved }, { status: 200 })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'UNKNOWN_ERROR'
    if (message === 'INVALID_RECIPIENTS') {
      return NextResponse.json({ error: message }, { status: 400 })
    }
    if (message.includes('ALREADY_SIGNED')) {
      return NextResponse.json({ error: 'ALREADY_SIGNED' }, { status: 409 })
    }
    if (message === 'NOT_FOUND') {
      return NextResponse.json({ error: 'NOT_FOUND' }, { status: 404 })
    }
    throw err
  }
}
