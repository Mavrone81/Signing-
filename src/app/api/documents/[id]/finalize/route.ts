import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { prisma } from '@/lib/db'
import { canAccessDocument } from '@/lib/rbac'
import { saveFields, finalize } from '@/server/documents/actions'
import type { FlatField } from '@/server/pdf/flatten'

// Runs the PDF flatten + certificate pipeline and encrypted storage via native
// Node APIs under per-request auth — Node runtime, never statically cached.
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function clientIp(req: NextRequest): string | null {
  // x-forwarded-for / x-real-ip are only trustworthy behind the nginx reverse
  // proxy on the deploy host, which sets them itself; direct origin access could spoof.
  return (
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    req.headers.get('x-real-ip') ??
    null
  )
}

// POST /api/documents/[id]/finalize — persist the latest field placement, then
// flatten + certificate + lock. Body: `{ fields: FlatField[] }` (Editor.tsx's
// Finalize button sends the current placement alongside the finalize request).
export async function POST(
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

  let fields: FlatField[]
  try {
    const body = await req.json()
    fields = body.fields
    if (!Array.isArray(fields)) throw new Error('bad body')
  } catch {
    return NextResponse.json({ error: 'INVALID_REQUEST' }, { status: 400 })
  }

  try {
    await saveFields(id, fields)
    const { signedSha256 } = await finalize(
      id,
      {
        id: session.user.id,
        name: session.user.name ?? '',
        email: session.user.email ?? '',
        role: session.user.role,
      },
      clientIp(req),
    )
    return NextResponse.json({ signedSha256 }, { status: 200 })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'UNKNOWN_ERROR'
    if (message === 'INVALID_FIELDS' || message === 'INCOMPLETE_FIELDS') {
      return NextResponse.json({ error: message }, { status: 400 })
    }
    if (message.includes('ALREADY_SIGNED')) {
      return NextResponse.json({ error: 'ALREADY_SIGNED' }, { status: 409 })
    }
    throw err
  }
}
