import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { prisma } from '@/lib/db'
import { createDocument } from '@/server/documents/actions'
import { env } from '@/env'

// Uses Prisma + fs-backed storage (native Node APIs) — must run on the Node
// runtime, not the Edge runtime.
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Small multipart-overhead margin allowed on top of MAX_UPLOAD_MB when
// pre-checking the declared Content-Length (boundary/header bytes).
const CONTENT_LENGTH_MARGIN_BYTES = 1024

function requestMeta(req: NextRequest) {
  // x-forwarded-for / x-real-ip are only trustworthy because this app sits
  // behind a reverse proxy that sets them itself. If that
  // boundary is ever bypassed (direct access to this origin), these headers
  // are client-controlled and can be spoofed.
  const ip =
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    req.headers.get('x-real-ip') ??
    null
  const userAgent = req.headers.get('user-agent')
  return { ip, userAgent }
}

export async function POST(req: NextRequest) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'UNAUTHENTICATED' }, { status: 401 })
  }
  // No organization → no tenant to own the upload. Fail closed.
  if (!session.user.orgId) {
    return NextResponse.json({ error: 'NO_ORGANIZATION' }, { status: 403 })
  }

  // Reject declared-oversized uploads before buffering the body at all
  // (req.formData() would materialize the whole thing in memory). This is a
  // fast-path optimization only — Content-Length can be absent or lie, so
  // createDocument still enforces the authoritative byte-length check.
  const contentLength = req.headers.get('content-length')
  if (contentLength !== null) {
    const declaredBytes = Number(contentLength)
    const maxBytes = env.MAX_UPLOAD_MB * 1024 * 1024 + CONTENT_LENGTH_MARGIN_BYTES
    if (Number.isFinite(declaredBytes) && declaredBytes > maxBytes) {
      return NextResponse.json({ error: 'TOO_LARGE' }, { status: 400 })
    }
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
  const name = file instanceof File ? file.name : 'document.pdf'

  try {
    const { id, pageCount } = await createDocument(session.user.id, session.user.orgId, name, bytes, requestMeta(req))
    return NextResponse.json({ id, pageCount }, { status: 201 })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'UNKNOWN_ERROR'
    if (message === 'INVALID_PDF' || message === 'TOO_LARGE') {
      return NextResponse.json({ error: message }, { status: 400 })
    }
    throw err
  }
}

export async function GET() {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'UNAUTHENTICATED' }, { status: 401 })
  }
  // No organization → nothing to list (and no query without an org scope).
  if (!session.user.orgId) {
    return NextResponse.json({ documents: [] })
  }

  // Always scope to the caller's org. Org owners/admins see every doc in the
  // org; a plain member sees only their own — never another tenant's.
  const isOrgAdmin = session.user.orgRole === 'owner' || session.user.orgRole === 'admin'
  const documents = await prisma.document.findMany({
    where: {
      orgId: session.user.orgId,
      ...(isOrgAdmin ? {} : { ownerId: session.user.id }),
    },
    orderBy: { createdAt: 'desc' },
  })

  return NextResponse.json({ documents })
}
