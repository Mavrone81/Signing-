// Server-only SMTP mailer. BEST-EFFORT by contract: sendEmail NEVER throws into
// the signing/send flow. If email is not configured it is a no-op that returns
// { sent: false, reason: 'not_configured' }; if the SMTP send fails it logs the
// error (NEVER the password) and returns { sent: false, reason: 'error' }.
import nodemailer from 'nodemailer'
import { getActiveEmailConfig, isEmailConfigured, type EmailRoute } from '@/lib/email-config'

export { isEmailConfigured }

export type MailAttachment = {
  filename: string
  content: Buffer
  contentType?: string
}

export type SendEmailInput = {
  // The org this mail is sent AS. Required, so every send site must name its
  // tenant: the org's own SMTP server is used when it has one, else the shared
  // server. `null` is only for mail that belongs to no org (shared server only).
  orgId: string | null
  to: string
  subject: string
  html: string
  text: string
  attachments?: MailAttachment[]
}

export type SendEmailResult =
  | { sent: true; via: EmailRoute }
  | { sent: false; reason: 'not_configured' | 'error'; error?: string; via?: EmailRoute }

export async function sendEmail(msg: SendEmailInput): Promise<SendEmailResult> {
  let cfg
  try {
    cfg = await getActiveEmailConfig(msg.orgId)
  } catch (err) {
    // Even reading/decrypting the config must never throw into the caller.
    console.error('[mailer] failed to read email config:', err instanceof Error ? err.message : String(err))
    return { sent: false, reason: 'error', error: 'config_read_failed' }
  }

  if (!cfg) return { sent: false, reason: 'not_configured' }

  try {
    const transport = nodemailer.createTransport({
      host: cfg.host,
      port: cfg.port,
      secure: cfg.secure,
      // Only authenticate when a username is configured; some relays accept
      // unauthenticated submission. The password is passed here but never logged.
      auth: cfg.username ? { user: cfg.username, pass: cfg.password ?? '' } : undefined,
    })

    const from = cfg.fromName ? `"${cfg.fromName}" <${cfg.fromEmail}>` : cfg.fromEmail

    await transport.sendMail({
      from,
      to: msg.to,
      subject: msg.subject,
      text: msg.text,
      html: msg.html,
      attachments: msg.attachments,
    })
    return { sent: true, via: cfg.via }
  } catch (err) {
    // Log the failure (message only — never the SMTP password or config).
    console.error('[mailer] send failed:', err instanceof Error ? err.message : String(err))
    return { sent: false, reason: 'error', error: err instanceof Error ? err.message : 'unknown', via: cfg.via }
  }
}
