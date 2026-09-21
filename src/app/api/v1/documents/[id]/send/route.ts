import { NextRequest, NextResponse } from 'next/server'
import { authenticateApiKey, apiClientIp, apiError } from '@/server/api/auth'
import { loadOrgDocument } from '@/server/api/documents'
import { sendForSignature } from '@/server/documents/actions'
import { env } from '@/env'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Canonical base for the returned signing links: configured AUTH_URL, else the
// request origin (usable on the current LAN deploy).
function baseUrl(req: NextRequest): string {
  return (env.AUTH_URL ?? new URL(req.url).origin).replace(/\/$/, '')
}

// POST /api/v1/documents/{id}/send — send for signature. Returns each recipient
// with their tokenized signing link. Optional body `{ expiresInDays: N }`.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticateApiKey(req)
  if (!auth.ok) return auth.response
  const { actorUserId } = auth.ctx

  const { id } = await params
  const doc = await loadOrgDocument(auth.ctx, id)
  if (!doc) return apiError('NOT_FOUND', 404)

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
      actorUserId,
      { ip: apiClientIp(req), userAgent: req.headers.get('user-agent'), baseUrl: base },
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
    if (message === 'NO_RECIPIENTS' || message === 'RECIPIENT_WITHOUT_FIELD') return apiError(message, 400)
    if (message.includes('ALREADY_SIGNED')) return apiError('ALREADY_SIGNED', 409)
    if (message === 'NOT_FOUND') return apiError('NOT_FOUND', 404)
    throw err
  }
}
