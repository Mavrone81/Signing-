import { NextRequest, NextResponse } from 'next/server'
import { authenticateApiKey, apiError } from '@/server/api/auth'
import { loadOrgDocument } from '@/server/api/documents'
import { saveFields } from '@/server/documents/actions'
import type { FlatField } from '@/server/pdf/flatten'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// POST /api/v1/documents/{id}/fields — set the field placement (replace-all).
// Body: `{ fields: FlatField[] }`. A field may be assigned to one of the
// document's own recipients via `recipientId`.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticateApiKey(req)
  if (!auth.ok) return auth.response
  const { orgId } = auth.ctx

  const { id } = await params
  const doc = await loadOrgDocument(orgId, id)
  if (!doc) return apiError('NOT_FOUND', 404)

  let fields: FlatField[]
  try {
    const body = await req.json()
    fields = body.fields
    if (!Array.isArray(fields)) throw new Error('bad body')
  } catch {
    return apiError('INVALID_REQUEST', 400)
  }

  try {
    await saveFields(id, fields)
    return NextResponse.json({ ok: true }, { status: 200 })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'UNKNOWN_ERROR'
    if (message === 'INVALID_FIELDS') return apiError(message, 400)
    if (message.includes('ALREADY_SIGNED')) return apiError('ALREADY_SIGNED', 409)
    if (message === 'NOT_FOUND') return apiError('NOT_FOUND', 404)
    throw err
  }
}
