import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { createDocumentFromTemplate } from '@/server/templates/actions'

// Creates a Document (Prisma + fs storage) under per-request auth — Node
// runtime, never statically cached.
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// POST /api/templates/[id]/use — create a new draft document from the template
// and return its id so the caller can open the editor.
export async function POST(
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
    const { documentId } = await createDocumentFromTemplate(id, {
      id: session.user.id,
      orgId: session.user.orgId,
      orgRole: session.user.orgRole,
    })
    return NextResponse.json({ documentId }, { status: 201 })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'UNKNOWN_ERROR'
    if (message === 'NOT_FOUND') return NextResponse.json({ error: message }, { status: 404 })
    throw err
  }
}
