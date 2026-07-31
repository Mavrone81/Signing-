import { NextRequest, NextResponse } from 'next/server'
import { declineSigning } from '@/server/documents/signing'

// PUBLIC, TOKEN-AUTHORIZED. This recipient refuses to sign → the whole document
// is marked declined and no one else can sign. Node runtime, never cached.
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function clientMeta(req: NextRequest) {
  const ip =
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    req.headers.get('x-real-ip') ??
    null
  return { ip, userAgent: req.headers.get('user-agent'), baseUrl: new URL(req.url).origin }
}

// POST /api/sign/[token]/decline
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params
  const res = await declineSigning(token, clientMeta(req))
  if (!res.ok) {
    const status = res.reason === 'not_found' ? 404 : 403
    return NextResponse.json({ error: res.reason }, { status })
  }
  return NextResponse.json({ status: 'declined' }, { status: 200 })
}
