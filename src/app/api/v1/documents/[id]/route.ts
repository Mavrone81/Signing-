import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { authenticateApiKey, apiError } from '@/server/api/auth'
import { loadOrgDocument, serializeDocument } from '@/server/api/documents'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// GET /api/v1/documents/{id} — status + recipients (org-scoped by the key).
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticateApiKey(req)
  if (!auth.ok) return auth.response
  const { orgId } = auth.ctx

  const { id } = await params
  const doc = await loadOrgDocument(orgId, id)
  if (!doc) return apiError('NOT_FOUND', 404)

  const recipients = await prisma.recipient.findMany({
    where: { documentId: doc.id },
    orderBy: { orderIndex: 'asc' },
    select: { id: true, name: true, email: true, status: true, orderIndex: true },
  })

  return NextResponse.json({ document: serializeDocument(doc, recipients) })
}
