import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { AuditAction } from '@prisma/client'
import { getObject } from '@/lib/storage'
import { authenticateApiKey, apiClientIp, apiError } from '@/server/api/auth'
import { loadOrgDocument } from '@/server/api/documents'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function sanitizeFilename(name: string): string {
  const stripped = name
    .replace(/[/\\]/g, '_')
    .replace(/["\r\n\x00-\x1f]/g, '')
    .trim()
  return stripped.length > 0 ? stripped : 'document.pdf'
}

function signedFilename(originalName: string): string {
  const base = sanitizeFilename(originalName).replace(/\.pdf$/i, '')
  return `${base}-signed.pdf`
}

function contentDispositionHeader(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_')
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`
}

// GET /api/v1/documents/{id}/signed — stream the completed signed PDF. 404 while
// no signed artifact exists (draft/sent/declined) so we never leak partial state.
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticateApiKey(req)
  if (!auth.ok) return auth.response

  const { id } = await params
  const doc = await loadOrgDocument(auth.ctx, id)
  if (!doc) return apiError('NOT_FOUND', 404)
  if (!doc.signedKey) return apiError('SIGNED_PDF_NOT_AVAILABLE', 409)

  const buf = await getObject(doc.signedKey)

  // Record the API download, best-effort (never fail a successful download).
  try {
    await prisma.auditEvent.create({
      data: {
        documentId: doc.id,
        userId: null,
        action: AuditAction.download,
        ip: apiClientIp(req),
        userAgent: req.headers.get('user-agent'),
        detail: { via: 'api' },
      },
    })
  } catch (err) {
    console.error('[api signed] audit failed:', err instanceof Error ? err.message : String(err))
  }

  return new NextResponse(new Blob([new Uint8Array(buf)]), {
    status: 200,
    headers: {
      'Content-Type': 'application/pdf',
      'Cache-Control': 'private, no-store',
      'Content-Disposition': contentDispositionHeader(signedFilename(doc.originalName)),
    },
  })
}
