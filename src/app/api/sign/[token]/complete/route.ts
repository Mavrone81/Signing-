import { NextRequest, NextResponse } from 'next/server'
import { completeSigning } from '@/server/documents/signing'

// PUBLIC, TOKEN-AUTHORIZED. Persists THIS recipient's field values, marks them
// signed, and finalizes the document if they were the last outstanding signer.
// Node runtime (Prisma + the PDF flatten/certificate pipeline), never cached.
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function clientMeta(req: NextRequest) {
  // x-forwarded-for / x-real-ip are trustworthy only behind the nginx reverse
  // proxy that sets them; a direct origin hit could spoof them (same caveat as
  // the sender-side routes).
  const ip =
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    req.headers.get('x-real-ip') ??
    null
  return { ip, userAgent: req.headers.get('user-agent'), baseUrl: new URL(req.url).origin }
}

// POST /api/sign/[token]/complete — body: { values: [{ fieldId, value }] }.
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params

  let values: { fieldId: string; value: string }[]
  try {
    const body = await req.json()
    values = body.values
    if (!Array.isArray(values)) throw new Error('bad body')
  } catch {
    return NextResponse.json({ error: 'INVALID_REQUEST' }, { status: 400 })
  }

  const res = await completeSigning(token, values, clientMeta(req))
  if (!res.ok) {
    // not_found → 404; invalid_values → 400; anything else (inactive / waiting /
    // already done) → 403.
    const status =
      res.reason === 'not_found' ? 404 : res.reason === 'invalid_values' ? 400 : 403
    return NextResponse.json({ error: res.reason }, { status })
  }
  return NextResponse.json({ status: res.completed ? 'completed' : 'signed' }, { status: 200 })
}
