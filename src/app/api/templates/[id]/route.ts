import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { deleteTemplate } from '@/server/templates/actions'

// Deletes a template (Prisma + fs storage) under per-request auth — Node
// runtime, never statically cached.
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// DELETE /api/templates/[id] — remove a template. Only the creator or an org
// owner/admin may delete it (enforced in deleteTemplate).
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'UNAUTHENTICATED' }, { status: 401 })
  }
  if (!session.user.orgId) {
    return NextResponse.json({ error: 'NO_ORGANIZATION' }, { status: 403 })
  }

  const { id } = await params
  try {
    await deleteTemplate(id, {
      id: session.user.id,
      orgId: session.user.orgId,
      orgRole: session.user.orgRole,
    })
    return NextResponse.json({ ok: true }, { status: 200 })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'UNKNOWN_ERROR'
    if (message === 'FORBIDDEN') return NextResponse.json({ error: message }, { status: 403 })
    if (message === 'NOT_FOUND') return NextResponse.json({ error: message }, { status: 404 })
    throw err
  }
}
