import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { prisma } from '@/lib/db'
import { canAccessDocument } from '@/lib/rbac'
import { sendForSignature } from '@/server/documents/actions'
import { env } from '@/env'

// Mints signing tokens + flips the document to `sent` via Prisma under
// per-request auth — Node runtime, never statically cached.
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function clientIp(req: NextRequest): string | null {
  return (
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    req.headers.get('x-real-ip') ??
    null
  )
}

// Base URL for the shareable signing links: the configured canonical AUTH_URL
// if present (the eventual HTTPS hostname), else the request's own origin so
// the links are usable on the current LAN deployment today.
function baseUrl(req: NextRequest): string {
  return (env.AUTH_URL ?? new URL(req.url).origin).replace(/\/$/, '')
}

// POST /api/documents/[id]/send — validate + send the document for signature.
// Returns the per-recipient signing links (no email yet — Phase 3) so the
// sender can copy/share them manually.
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

  // Optional expiry: the sender may pass `{ expiresInDays: N }`. A body is
  // optional (older clients POST nothing) — parse leniently and ignore anything
  // that isn't a positive number (sendForSignature re-validates it too).
  let expiresInDays: number | null = null
  try {
    const body = (await req.json()) as { expiresInDays?: unknown } | null
    const raw = body?.expiresInDays
    if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) expiresInDays = raw
  } catch {
    // No/invalid JSON body → no expiry.
  }

  try {
    const base = baseUrl(req)
    const recipients = await sendForSignature(
      id,
      session.user.id,
      {
        ip: clientIp(req),
        userAgent: req.headers.get('user-agent'),
        // So notification emails build absolute /sign/<token> links on this deploy.
        baseUrl: base,
      },
      { expiresInDays },
    )
    return NextResponse.json(
      {
        recipients: recipients.map((r) => ({
          id: r.id,
          name: r.name,
          email: r.email,
          orderIndex: r.orderIndex,
          status: r.status,
          signingUrl: `${base}/sign/${r.token}`,
        })),
      },
      { status: 200 },
    )
  } catch (err) {
    const message = err instanceof Error ? err.message : 'UNKNOWN_ERROR'
    if (message === 'NO_RECIPIENTS' || message === 'RECIPIENT_WITHOUT_FIELD') {
      return NextResponse.json({ error: message }, { status: 400 })
    }
    if (message.includes('ALREADY_SIGNED')) {
      return NextResponse.json({ error: 'ALREADY_SIGNED' }, { status: 409 })
    }
    if (message === 'NOT_FOUND') {
      return NextResponse.json({ error: 'NOT_FOUND' }, { status: 404 })
    }
    throw err
  }
}
