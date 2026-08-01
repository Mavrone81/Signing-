import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { prisma } from '@/lib/db'
import { AuditAction } from '@prisma/client'
import { getObject } from '@/lib/storage'
import { canAccessDocument } from '@/lib/rbac'

// Decrypts + streams a document's PDF bytes. Uses native fs/crypto (via
// getObject) and runs per-request auth, so it must run on the Node runtime and
// never be statically cached.
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function requestMeta(req: NextRequest) {
  // x-forwarded-for / x-real-ip are only trustworthy because this app sits
  // behind a reverse proxy that sets them itself. If that
  // boundary is ever bypassed (direct access to this origin), these headers
  // are client-controlled and can be spoofed. Same pattern as
  // src/app/api/documents/route.ts / .../finalize/route.ts.
  const ip =
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    req.headers.get('x-real-ip') ??
    null
  const userAgent = req.headers.get('user-agent')
  return { ip, userAgent }
}

// Strips characters that would break a Content-Disposition header or let a
// crafted originalName inject path separators / control chars into it
// (quotes, `/`/`\`, CR/LF, other control bytes). Falls back to a generic name
// if sanitizing leaves nothing usable.
function sanitizeFilename(name: string): string {
  const stripped = name
    .replace(/[/\\]/g, '_')
    .replace(/["\r\n\x00-\x1f]/g, '')
    .trim()
  return stripped.length > 0 ? stripped : 'document.pdf'
}

// `<base>-signed.pdf`, derived from the (sanitized) original filename with
// any trailing `.pdf` stripped first so the result doesn't read
// "contract.pdf-signed.pdf".
function signedFilename(originalName: string): string {
  const safe = sanitizeFilename(originalName)
  const base = safe.replace(/\.pdf$/i, '')
  return `${base}-signed.pdf`
}

// RFC 6266/5987-style header: an ASCII-safe `filename=` for older clients plus
// a `filename*=UTF-8''...` extended form so non-ASCII names round-trip too.
function contentDispositionHeader(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_')
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`
}

// Minimal read route so the client editor (Task 10) can render the original
// PDF. Task 13 formally owns this route and extends it with the `download`
// AuditEvent + Content-Disposition semantics.
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; kind: string }> },
) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'UNAUTHENTICATED' }, { status: 401 })
  }

  const { id, kind } = await params
  if (kind !== 'original' && kind !== 'signed') {
    return NextResponse.json({ error: 'NOT_FOUND' }, { status: 404 })
  }

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

  const key = kind === 'signed' ? doc.signedKey : doc.originalKey
  if (!key) {
    return NextResponse.json({ error: 'NOT_FOUND' }, { status: 404 })
  }

  const buf = await getObject(key)

  // Only the signed download is audited. The editor's Viewer fetches
  // `/file/original` via `fetch()`+`arrayBuffer()` on every render just to
  // display the PDF, which would spam the audit log with meaningless events;
  // the original is already audited once, at upload (createDocument). A
  // `signed` GET, by contrast, is the meaningful "user downloaded the
  // finished, certificated document" event, and is recorded only after the
  // RBAC check has passed and the encrypted blob was actually found +
  // decrypted successfully.
  if (kind === 'signed') {
    const { ip, userAgent } = requestMeta(req)
    // Best-effort audit: the blob is already decrypted and about to be served,
    // so a transient DB failure here must NOT turn a successful download into a
    // 500. Log and serve; the missing audit row is preferable to a failed
    // download the user has to retry.
    try {
      await prisma.auditEvent.create({
        data: {
          documentId: doc.id,
          userId: session.user.id,
          action: AuditAction.download,
          ip,
          userAgent,
        },
      })
    } catch (err) {
      console.error('failed to record download audit event', { documentId: doc.id, err })
    }
  }

  const filename =
    kind === 'signed' ? signedFilename(doc.originalName) : sanitizeFilename(doc.originalName)

  return new NextResponse(new Blob([new Uint8Array(buf)]), {
    status: 200,
    headers: {
      'Content-Type': 'application/pdf',
      'Cache-Control': 'private, no-store',
      'Content-Disposition': contentDispositionHeader(filename),
    },
  })
}
