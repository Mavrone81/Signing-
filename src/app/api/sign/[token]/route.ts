import { NextRequest, NextResponse } from 'next/server'
import { getObject } from '@/lib/storage'
import { signerFileKey } from '@/server/documents/signing'

// PUBLIC, TOKEN-AUTHORIZED. Decrypts + streams a sent document's ORIGINAL PDF
// bytes for the recipient's signing viewer. Authorized ONLY by a valid signing
// token (never an org session), so it must run on the Node runtime (native
// fs/crypto via getObject) and never be statically cached.
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// GET /api/sign/[token] — the original PDF, gated by a valid sent-recipient
// token. Any invalid/closed/out-of-turn token gets 404/403 and no bytes.
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params
  const res = await signerFileKey(token)
  if (!res.ok) {
    const status = res.reason === 'not_found' ? 404 : 403
    return NextResponse.json({ error: res.reason }, { status })
  }

  const buf = await getObject(res.originalKey)
  return new NextResponse(new Blob([new Uint8Array(buf)]), {
    status: 200,
    headers: {
      'Content-Type': 'application/pdf',
      // Never cache a token-gated document blob.
      'Cache-Control': 'private, no-store',
    },
  })
}
