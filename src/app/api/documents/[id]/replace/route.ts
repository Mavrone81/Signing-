import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { prisma } from '@/lib/db'
import { canAccessDocument } from '@/lib/rbac'
import { replaceDocumentFile } from '@/server/documents/actions'
import { env } from '@/env'

// Prisma + fs-backed storage — Node runtime, never statically cached.
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const CONTENT_LENGTH_MARGIN_BYTES = 1024

function requestMeta(req: NextRequest) {
  // Trustworthy only because the reverse proxy sets these itself (see the
  // upload route for the same caveat).
  const ip =
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    req.headers.get('x-real-ip') ??
    null
  return { ip, userAgent: req.headers.get('user-agent') }
}

// POST /api/documents/[id]/replace — swap a DRAFT document's PDF (multipart
// `file`), keeping its recipients. Returns the new page count and how many
// placed fields were dropped because their page no longer exists.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'UNAUTHENTICATED' }, { status: 401 })
  }

  const { id } = await params
  const doc = await prisma.document.findUnique({ where: { id }, select: { ownerId: true, orgId: true } })
  if (!doc) return NextResponse.json({ error: 'NOT_FOUND' }, { status: 404 })
  if (
    !canAccessDocument(
      { id: session.user.id, orgId: session.user.orgId, orgRole: session.user.orgRole },
      doc,
    )
  ) {
    return NextResponse.json({ error: 'FORBIDDEN' }, { status: 403 })
  }

  const contentLength = Number(req.headers.get('content-length'))
  if (Number.isFinite(contentLength) && contentLength > env.MAX_UPLOAD_MB * 1024 * 1024 + CONTENT_LENGTH_MARGIN_BYTES) {
    return NextResponse.json({ error: 'TOO_LARGE' }, { status: 400 })
  }

  let form: FormData
  try {
    form = await req.formData()
  } catch {
    return NextResponse.json({ error: 'INVALID_REQUEST' }, { status: 400 })
  }
  const file = form.get('file')
  if (!(file instanceof Blob)) {
    return NextResponse.json({ error: 'MISSING_FILE' }, { status: 400 })
  }

  const bytes = Buffer.from(await file.arrayBuffer())
  const name = file instanceof File && file.name ? file.name : 'document.pdf'

  try {
    const result = await replaceDocumentFile(id, session.user.id, name, bytes, requestMeta(req))
    return NextResponse.json(result, { status: 200 })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'UNKNOWN_ERROR'
    if (message === 'INVALID_PDF' || message === 'TOO_LARGE') {
      return NextResponse.json({ error: message }, { status: 400 })
    }
    if (message === 'NOT_DRAFT') return NextResponse.json({ error: message }, { status: 409 })
    if (message === 'NOT_FOUND') return NextResponse.json({ error: message }, { status: 404 })
    throw err
  }
}
