// Server-only, BEST-EFFORT invite email for Settings → Team. NEVER THROWS: a
// missing SMTP config, a mail failure, or a DB read error must not break adding
// a member (the temp password is always still shown once on screen). Mirrors the
// best-effort contract of src/server/documents/notify.ts.
import { prisma } from '@/lib/db'
import { env } from '@/env'
import { sendEmail, type SendEmailResult } from '@/lib/mailer'
import { renderTeamInviteEmail, type EmailBrand } from '@/lib/email-templates'
import { resolveBrand } from '@/lib/branding'

// Canonical base for the sign-in link (resolved live origin when available, else
// AUTH_URL). May be '' pre-HTTPS — the link then renders relative and the
// on-screen temp password remains the working fallback.
function baseUrl(explicit?: string | null): string {
  return (explicit || env.AUTH_URL || '').replace(/\/+$/, '')
}

/**
 * Best-effort: email a newly added teammate their temporary password + a sign-in
 * link, branded with their new org. Returns the send result (never throws) — the
 * caller may surface whether it was sent, but adding the member never depends on
 * it. The temp password is passed through to the email only; it is never logged.
 */
export async function sendTeamInvite(opts: {
  orgId: string
  toName: string
  toEmail: string
  inviterName: string
  tempPassword: string
  origin?: string | null
}): Promise<SendEmailResult> {
  try {
    const org = await prisma.organization.findUnique({
      where: { id: opts.orgId },
      select: { name: true, brandName: true, brandColor: true, logoKey: true },
    })
    const resolved = org ? resolveBrand(org) : null
    const brand: EmailBrand | undefined = resolved?.customized
      ? { name: resolved.name, color: resolved.color }
      : undefined
    const orgName = resolved?.name ?? org?.name ?? 'your organization'

    const base = baseUrl(opts.origin)
    const email = renderTeamInviteEmail({
      recipientName: opts.toName,
      inviterName: opts.inviterName,
      orgName,
      email: opts.toEmail,
      tempPassword: opts.tempPassword,
      loginUrl: base ? `${base}/login` : undefined,
      brand,
    })

    return await sendEmail({ to: opts.toEmail, subject: email.subject, html: email.html, text: email.text })
  } catch (err) {
    console.error('[team] invite email failed:', err instanceof Error ? err.message : String(err))
    return { sent: false, reason: 'error', error: 'invite_send_failed' }
  }
}
