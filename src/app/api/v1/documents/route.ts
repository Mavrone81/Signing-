import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { createDocument } from '@/server/documents/actions'
import { authenticateApiKey, apiClientIp, apiError } from '@/server/api/auth'
import { serializeDocument } from '@/server/api/documents'
import { env } from '@/env'

// Public REST API — Prisma + fs-backed storage (native Node APIs), authenticated
// per-request by an API key (never the session). Node runtime, never cached.
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const CONTENT_LENGTH_MARGIN_BYTES = 1024
const MAX_PAGE_SIZE = 100
const DEFAULT_PAGE_SIZE = 25

// POST /api/v1/documents — multipart upload a PDF (field `file`). Reuses
// createDocument scoped to the key's org, with the key's creator as owner.
export async function POST(req: NextRequest) {
  const auth = await authenticateApiKey(req)
  if (!auth.ok) return auth.response
  const { orgId, actorUserId } = auth.ctx

  const contentLength = req.headers.get('content-length')
  if (contentLength !== null) {
    const declaredBytes = Number(contentLength)
    const maxBytes = env.MAX_UPLOAD_MB * 1024 * 1024 + CONTENT_LENGTH_MARGIN_BYTES
    if (Number.isFinite(declaredBytes) && declaredBytes > maxBytes) {
      return apiError('TOO_LARGE', 400)
    }
  }

  let form: FormData
  try {
    form = await req.formData()
  } catch {
    return apiError('INVALID_REQUEST', 400)
  }

  const file = form.get('file')
  if (!(file instanceof Blob)) {
    return apiError('MISSING_FILE', 400)
  }

  const bytes = Buffer.from(await file.arrayBuffer())
  const name = file instanceof File ? file.name : 'document.pdf'

  try {
    const { id, pageCount } = await createDocument(actorUserId, orgId, name, bytes, {
      ip: apiClientIp(req),
      userAgent: req.headers.get('user-agent'),
    })
    return NextResponse.json({ id, status: 'draft', pageCount }, { status: 201 })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'UNKNOWN_ERROR'
    if (message === 'INVALID_PDF' || message === 'TOO_LARGE') {
      return apiError(message, 400)
    }
    throw err
  }
}

// GET /api/v1/documents — paginated list, scoped to the key's org.
// Query: `?limit=<1..100>&offset=<n>`.
export async function GET(req: NextRequest) {
  const auth = await authenticateApiKey(req)
  if (!auth.ok) return auth.response
  const { orgId } = auth.ctx

  const url = new URL(req.url)
  const limitRaw = Number(url.searchParams.get('limit'))
  const offsetRaw = Number(url.searchParams.get('offset'))
  const limit =
    Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(Math.floor(limitRaw), MAX_PAGE_SIZE) : DEFAULT_PAGE_SIZE
  const offset = Number.isFinite(offsetRaw) && offsetRaw > 0 ? Math.floor(offsetRaw) : 0

  const [total, docs] = await Promise.all([
    prisma.document.count({ where: { orgId } }),
    prisma.document.findMany({
      where: { orgId },
      orderBy: { createdAt: 'desc' },
      skip: offset,
      take: limit,
    }),
  ])

  return NextResponse.json({
    documents: docs.map((d) => serializeDocument(d)),
    pagination: { total, limit, offset },
  })
}
