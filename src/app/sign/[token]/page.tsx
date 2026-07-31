import type { Metadata } from 'next'
import { viewSigner, type SignerBlockReason } from '@/server/documents/signing'
import { SignerFiller } from '@/components/sign/SignerFiller'
import { loadLogoDataUri } from '@/lib/branding'

export const metadata: Metadata = { title: 'Sign · Bevora Sign' }

// PUBLIC (unauthenticated) recipient signing page. Authorization is the token
// in the path, validated per-request in viewSigner against a specific
// Recipient — never an org session. Must be dynamic (per-request DB read +
// first-view side effect), never prerendered.
export const dynamic = 'force-dynamic'

// Friendly, non-crashing copy for every reason a token can't sign right now.
const BLOCKED: Record<SignerBlockReason, { title: string; body: string }> = {
  not_found: {
    title: 'This link is no longer active',
    body: 'The signing link is invalid or has expired. Please ask the sender for a new one.',
  },
  inactive: {
    title: 'This link is no longer active',
    body: 'This document is no longer accepting signatures.',
  },
  waiting: {
    title: 'Waiting for an earlier signer',
    body: 'This document is signed in order, and it is not your turn yet. You will be able to sign once the earlier recipients have finished.',
  },
  done_signed: {
    title: "You've already signed — thank you",
    body: 'Your signature has already been recorded for this document. There is nothing more to do.',
  },
  done_declined: {
    title: 'This request was declined',
    body: 'You previously declined to sign this document.',
  },
  expired: {
    title: 'This signing link has expired',
    body: 'The deadline for signing this document has passed, so it can no longer be signed. Please ask the sender to send it again if you still need to sign.',
  },
}

export default async function SignPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const result = await viewSigner(token)

  if (!result.ok) {
    const { title, body } = BLOCKED[result.reason]
    return (
      <div className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center px-6 text-center">
        <h1 className="text-[20px] font-semibold text-ink">{title}</h1>
        <p className="mt-2 text-[14px] text-muted">{body}</p>
      </div>
    )
  }

  // Inline the org's logo as a data URI (token-authorized — no separate public
  // logo route the anonymous signer would hit). Only when the org customized.
  const { brand } = result
  const logoDataUri = brand.customized ? await loadLogoDataUri(brand.logoKey) : null

  return (
    <SignerFiller
      token={result.token}
      recipientName={result.recipient.name}
      documentName={result.document.originalName}
      fields={result.fields}
      brandName={brand.customized ? brand.name : null}
      brandColor={brand.customized ? brand.color : null}
      brandLogo={logoDataUri}
    />
  )
}
