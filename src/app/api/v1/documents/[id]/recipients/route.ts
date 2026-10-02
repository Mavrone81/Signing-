import { NextRequest, NextResponse } from 'next/server'
import { authenticateApiKey, apiError } from '@/server/api/auth'
import { loadOrgDocument, serializeRecipient } from '@/server/api/documents'
import { saveRecipients, type RecipientInput } from '@/server/documents/actions'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// POST /api/v1/documents/{id}/recipients — set the recipient list (replace-all).
// Body: `{ recipients: [{ name, email, orderIndex? }], signingOrder? }`.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticateApiKey(req)
  if (!auth.ok) return auth.response

  const { id } = await params
  const doc = await loadOrgDocument(auth.ctx, id)
  if (!doc) return apiError('NOT_FOUND', 404)

  let recipients: RecipientInput[]
  let signingOrder: 'parallel' | 'sequential' | undefined
  try {
    const body = await req.json()
    recipients = body.recipients
    if (!Array.isArray(recipients)) throw new Error('bad body')
    signingOrder =
      body.signingOrder === 'parallel' || body.signingOrder === 'sequential' ? body.signingOrder : undefined
  } catch {
    return apiError('INVALID_REQUEST', 400)
  }

  try {
    const saved = await saveRecipients(id, recipients, { signingOrder })
    return NextResponse.json({ recipients: saved.map(serializeRecipient) }, { status: 200 })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'UNKNOWN_ERROR'
    if (message === 'INVALID_RECIPIENTS') return apiError(message, 400)
    if (message.includes('ALREADY_SIGNED')) return apiError('ALREADY_SIGNED', 409)
    if (message === 'NOT_FOUND') return apiError('NOT_FOUND', 404)
    throw err
  }
}
