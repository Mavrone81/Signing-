import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { hashApiKey, looksLikeApiKey } from '@/lib/api-keys'

// The authenticated context for a `/api/v1` request: the resolved tenant org
// plus the synthetic actor (the key's creator) used as document owner / audit
// userId for API-driven actions. This is the ONLY tenant scope such a request
// may ever touch — every route loads/acts within `orgId`.
export interface ApiKeyContext {
  keyId: string
  orgId: string
  actorUserId: string
}

export type ApiAuthResult =
  | { ok: true; ctx: ApiKeyContext }
  | { ok: false; response: NextResponse }

// Consistent JSON error shape for the whole public API.
export function apiError(error: string, status: number, extra?: Record<string, unknown>): NextResponse {
  return NextResponse.json({ error, ...extra }, { status })
}

/**
 * Authenticates a `/api/v1` request by its `Authorization: Bearer sk_...` header
 * (NEVER the user session). The presented token is SHA-256 hashed and looked up
 * against a NON-REVOKED ApiKey; the row's org becomes the request's tenant scope.
 * `lastUsedAt` is stamped best-effort (a failure there never fails the request).
 * Any missing / malformed / unknown / revoked key returns 401 — the raw key is
 * never compared directly and never logged.
 */
export async function authenticateApiKey(req: NextRequest): Promise<ApiAuthResult> {
  const header = req.headers.get('authorization') ?? ''
  const match = /^Bearer\s+(.+)$/i.exec(header.trim())
  if (!match) {
    return { ok: false, response: apiError('UNAUTHORIZED', 401) }
  }
  const raw = match[1].trim()
  if (!looksLikeApiKey(raw)) {
    return { ok: false, response: apiError('UNAUTHORIZED', 401) }
  }

  const hashedKey = hashApiKey(raw)
  const key = await prisma.apiKey.findFirst({
    where: { hashedKey, revokedAt: null },
    select: { id: true, orgId: true, createdById: true },
  })
  if (!key) {
    return { ok: false, response: apiError('UNAUTHORIZED', 401) }
  }

  // Best-effort usage stamp — must never turn a valid request into a failure.
  try {
    await prisma.apiKey.update({ where: { id: key.id }, data: { lastUsedAt: new Date() } })
  } catch (err) {
    console.error('[api-auth] lastUsedAt stamp failed:', err instanceof Error ? err.message : String(err))
  }

  return { ok: true, ctx: { keyId: key.id, orgId: key.orgId, actorUserId: key.createdById } }
}

// Client IP from the reverse-proxy headers (same trust model as the session
// routes: only trustworthy behind the nginx boundary that sets them).
export function apiClientIp(req: NextRequest): string | null {
  return (
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    req.headers.get('x-real-ip') ??
    null
  )
}
