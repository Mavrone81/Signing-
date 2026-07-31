import { NextRequest, NextResponse } from 'next/server'
import { revalidatePath } from 'next/cache'
import { auth } from '@/auth'
import { deleteDocument } from '@/server/documents/actions'

// Deletes a Document (+ blobs) via native fs/crypto (deleteObject) under
// per-request auth — Node runtime, never statically cached.
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// DELETE /api/documents/[id] — permanently remove a document: best-effort
// deletes both encrypted blobs (original + signed, if present), then the
// Document row (Field/Recipient/AuditEvent cascade at the DB level).
//
// Authorization is `canAccessDocument` (enforced inside `deleteDocument`): a
// member may delete only their own document; an org owner/admin may delete
// any document in their org. A missing document and an unauthorized one
// (same-org non-owner, or a different org) both 404 — deliberately never a
// separate 403 — so the response can never reveal whether a document the
// caller isn't allowed to touch even exists.
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'UNAUTHENTICATED' }, { status: 401 })
  }

  const { id } = await params
  try {
    await deleteDocument(id, {
      id: session.user.id,
      orgId: session.user.orgId,
      orgRole: session.user.orgRole,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'UNKNOWN_ERROR'
    if (message === 'NOT_FOUND') return NextResponse.json({ error: message }, { status: 404 })
    throw err
  }

  // Best-effort: refreshes the documents list's cached render. Wrapped
  // because revalidatePath requires an active Next.js request-render context
  // (the "static generation store") that isn't present when this route is
  // invoked directly in tests — that must never turn an already-committed
  // delete into a 500.
  try {
    revalidatePath('/documents')
  } catch (err) {
    console.error('[DELETE /api/documents/:id] revalidatePath failed:', err instanceof Error ? err.message : String(err))
  }

  return NextResponse.json({ ok: true }, { status: 200 })
}
