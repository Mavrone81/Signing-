import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { prisma } from '@/lib/db'
import { getObject } from '@/lib/storage'
import { logoMimeFromKey } from '@/lib/branding'

// ORG-SESSION-AUTHORIZED logo stream for AUTHENTICATED app members. A member may
// only read their OWN org's logo: the requested orgId MUST equal the session's
// orgId — one org can never read another's blob, and there is no anonymous
// access here (the unauthenticated signer surface inlines its logo via the
// token-scoped page instead, never this route). Node runtime for fs/crypto.
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const { orgId } = await params
  const session = await auth()
  // Tenancy gate: must be signed in AND a member of exactly this org.
  if (!session?.user?.orgId || session.user.orgId !== orgId) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const org = await prisma.organization.findUnique({
    where: { id: orgId },
    select: { logoKey: true },
  })
  if (!org?.logoKey) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 })
  }

  let buf: Buffer
  try {
    buf = await getObject(org.logoKey)
  } catch {
    return NextResponse.json({ error: 'not_found' }, { status: 404 })
  }

  return new NextResponse(new Blob([new Uint8Array(buf)]), {
    status: 200,
    headers: {
      'Content-Type': logoMimeFromKey(org.logoKey),
      // Private to the authenticated member; never shared/CDN-cached.
      'Cache-Control': 'private, no-store',
    },
  })
}
