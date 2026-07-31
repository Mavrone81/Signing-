import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { saveAsTemplate, listTemplates } from '@/server/templates/actions'

// Uses Prisma + fs-backed storage (native Node APIs) under per-request auth —
// must run on the Node runtime and never be statically cached.
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// POST /api/templates — save an existing document's layout as a reusable
// template. Body: { documentId, name, description? }.
export async function POST(req: NextRequest) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'UNAUTHENTICATED' }, { status: 401 })
  }
  if (!session.user.orgId) {
    return NextResponse.json({ error: 'NO_ORGANIZATION' }, { status: 403 })
  }

  let documentId: string
  let name: string
  let description: string | null
  try {
    const body = await req.json()
    documentId = body.documentId
    name = body.name
    description = typeof body.description === 'string' ? body.description : null
    if (typeof documentId !== 'string' || typeof name !== 'string') throw new Error('bad body')
  } catch {
    return NextResponse.json({ error: 'INVALID_REQUEST' }, { status: 400 })
  }

  try {
    const tpl = await saveAsTemplate(documentId, name, description, {
      id: session.user.id,
      orgId: session.user.orgId,
      orgRole: session.user.orgRole,
    })
    return NextResponse.json(tpl, { status: 201 })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'UNKNOWN_ERROR'
    if (message === 'INVALID_NAME') return NextResponse.json({ error: message }, { status: 400 })
    if (message === 'FORBIDDEN') return NextResponse.json({ error: message }, { status: 403 })
    if (message === 'NOT_FOUND') return NextResponse.json({ error: message }, { status: 404 })
    throw err
  }
}

// GET /api/templates — list this org's templates (org-scoped).
export async function GET() {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'UNAUTHENTICATED' }, { status: 401 })
  }
  if (!session.user.orgId) {
    return NextResponse.json({ templates: [] })
  }
  const templates = await listTemplates({
    id: session.user.id,
    orgId: session.user.orgId,
    orgRole: session.user.orgRole,
  })
  return NextResponse.json({ templates })
}
