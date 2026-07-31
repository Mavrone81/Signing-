import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { prisma } from '@/lib/db'
import { canAccessDocument } from '@/lib/rbac'
import { resetToDraft } from '@/server/documents/actions'

// Deletes the signed blob + reverts DB status via native Node APIs under
// per-request auth — Node runtime, never statically cached.
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// POST /api/documents/[id]/reset — revert a signed document to draft so it can
// be re-edited and re-finalized.
export async function POST(
  _req: NextRequest,
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

  await resetToDraft(id, session.user.id)
  return NextResponse.json({ ok: true }, { status: 200 })
}
