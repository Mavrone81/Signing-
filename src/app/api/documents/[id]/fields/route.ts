import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { prisma } from '@/lib/db'
import { canAccessDocument } from '@/lib/rbac'
import { saveFields } from '@/server/documents/actions'
import type { FlatField } from '@/server/pdf/flatten'

// Persists field placement via Prisma (native Node APIs) under per-request
// auth — must run on the Node runtime and never be statically cached.
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// PUT /api/documents/[id]/fields — replace the document's saved field
// placement. Body: `{ fields: FlatField[] }` (what Editor.tsx's Save sends).
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
    return NextResponse.json({ ok: true }, { status: 200 })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'UNKNOWN_ERROR'
    if (message === 'INVALID_FIELDS') {
      return NextResponse.json({ error: message }, { status: 400 })
    }
    if (message.includes('ALREADY_SIGNED')) {
      return NextResponse.json({ error: 'ALREADY_SIGNED' }, { status: 409 })
    }
    throw err
  }
}
