import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { prisma } from '@/lib/db'
import { canAccessDocument } from '@/lib/rbac'
import { getObject } from '@/lib/storage'
import { verifyPades } from '@/server/pdf/pades'
import { buildAuditReport, type AuditReportEvent, type AuditReportSeal } from '@/server/pdf/audit-report'

// Builds a PDF audit-trail report with pdf-lib (native fonts/crypto) under
// per-request auth — Node runtime, never statically cached. Audit trails are
// tenant data, so this route is org-gated via canAccessDocument.
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Same Content-Disposition hardening as the file route: strip anything that
// could break the header or inject separators/control chars.
function sanitizeFilename(name: string): string {
  const stripped = name
    .replace(/[/\\]/g, '_')
    .replace(/["\r\n\x00-\x1f]/g, '')
    .trim()
  return stripped.length > 0 ? stripped : 'document'
}

function contentDispositionHeader(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_')
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`
}

export async function GET(
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

  const events = await prisma.auditEvent.findMany({
    where: { documentId: id },
    orderBy: { createdAt: 'asc' },
  })

  // Resolve actor identities. User events → the acting User's name/email
  // (batch-loaded). Recipient events (sign/decline) carry the recipient's
  // identity in `detail`. Anything else → System.
  const userIds = Array.from(
    new Set(events.map((e) => e.userId).filter((u): u is string => !!u)),
  )
  const users = userIds.length
    ? await prisma.user.findMany({
        where: { id: { in: userIds } },
        select: { id: true, name: true, email: true },
      })
    : []
  const userById = new Map(users.map((u) => [u.id, u]))

  const reportEvents: AuditReportEvent[] = events.map((e) => {
    let actorName: string | null = null
    let actorEmail: string | null = null
    if (e.userId) {
      const u = userById.get(e.userId)
      actorName = u?.name ?? null
      actorEmail = u?.email ?? null
    } else {
      const d = e.detail as { recipientName?: string; recipientEmail?: string } | null
      actorName = d?.recipientName ?? null
      actorEmail = d?.recipientEmail ?? null
    }
    return {
      action: e.action,
      createdAt: e.createdAt,
      actorName,
      actorEmail,
      ip: e.ip,
      userAgent: e.userAgent,
    }
  })

  // If the finished PDF is PAdES-sealed, note the (public) seal in the report.
  // Verified from the stored bytes, so it reflects what was actually signed —
  // never any secret key material.
  let seal: AuditReportSeal | null = null
  if (doc.signedKey) {
    try {
      const signedBytes = await getObject(doc.signedKey)
      const v = verifyPades(signedBytes)
      if (v.signed) {
        seal = {
          signerSubject: v.signerSubject ?? 'unknown',
          fingerprint: v.signerFingerprint ?? 'n/a',
          valid: v.valid,
          signingTime: v.signingTime ?? null,
          timestamped: !!v.timestamped,
        }
      }
    } catch (err) {
      console.error('[audit] seal verify failed', { documentId: id, err })
    }
  }

  const pdf = await buildAuditReport({
    documentName: doc.originalName,
    status: doc.status,
    originalSha256: doc.originalSha256,
    signedSha256: doc.signedSha256,
    events: reportEvents,
    seal,
  })

  const base = sanitizeFilename(doc.originalName).replace(/\.pdf$/i, '')
  const filename = `${base}-audit-trail.pdf`

  return new NextResponse(new Blob([new Uint8Array(pdf)]), {
    status: 200,
    headers: {
      'Content-Type': 'application/pdf',
      'Cache-Control': 'private, no-store',
      'Content-Disposition': contentDispositionHeader(filename),
    },
  })
}
