// Server-only notification orchestration for the send-for-signature flow.
//
// EVERY function here is BEST-EFFORT and NEVER THROWS: a mail (or DB, or
// storage) failure must not break send / sign / complete / decline. Each send
// attempt is wrapped and records a `notify` AuditEvent (sent true/false + reason
// on failure) so the intended notification is always auditable — including when
// SMTP is not configured (the no-op still records reason 'not_configured').
import { RecipientStatus } from '@prisma/client'
import { prisma } from '@/lib/db'
import { env } from '@/env'
import { getObject } from '@/lib/storage'
import { sendEmail, type SendEmailResult } from '@/lib/mailer'
import {
  renderRequestEmail,
  renderCompletedEmail,
  renderDeclinedEmail,
  type EmailBrand,
} from '@/lib/email-templates'
import { resolveBrand } from '@/lib/branding'

// Canonical base for links in emails: the resolved live origin when the caller
// has one (routes), else the configured AUTH_URL. Trailing slash trimmed. May
// be '' pre-HTTPS/AUTH_URL — links then render relative (degraded, non-fatal;
// the sender-side copy-link UI remains the working fallback).
export function appBaseUrl(explicit?: string | null): string {
  return (explicit || env.AUTH_URL || '').replace(/\/+$/, '')
}

const signUrl = (base: string, token: string) => `${base}/sign/${token}`
const docUrl = (base: string, documentId: string) => `${base}/documents/${documentId}/edit`

// Record the outcome of one notification attempt. Never throws.
async function auditNotify(
  documentId: string,
  kind: string,
  to: string,
  result: SendEmailResult,
): Promise<void> {
  try {
    await prisma.auditEvent.create({
      data: {
        documentId,
        userId: null,
        action: 'notify',
        detail: {
          kind,
          to,
          sent: result.sent,
          ...(result.sent ? {} : { reason: result.reason }),
        },
      },
    })
  } catch (err) {
    console.error('[notify] audit write failed:', err instanceof Error ? err.message : String(err))
  }
}

// Send one templated email + audit it. Never throws. Returns the mailer result.
async function deliver(
  documentId: string,
  kind: string,
  to: string,
  rendered: { subject: string; html: string; text: string },
  attachments?: { filename: string; content: Buffer; contentType?: string }[],
): Promise<SendEmailResult> {
  let result: SendEmailResult
  try {
    result = await sendEmail({ to, ...rendered, attachments })
  } catch (err) {
    // sendEmail is contractually non-throwing, but belt-and-braces here.
    console.error('[notify] deliver failed:', err instanceof Error ? err.message : String(err))
    result = { sent: false, reason: 'error', error: 'deliver_failed' }
  }
  await auditNotify(documentId, kind, to, result)
  return result
}

// Load the doc + owner (sender) + ordered recipients + the tenant org's brand
// for a notification. Returns null on any failure (best-effort — caller no-ops).
async function loadDoc(documentId: string) {
  try {
    return await prisma.document.findUnique({
      where: { id: documentId },
      include: {
        owner: { select: { name: true, email: true } },
        recipients: { orderBy: { orderIndex: 'asc' } },
        org: { select: { name: true, brandName: true, brandColor: true, logoKey: true } },
      },
    })
  } catch (err) {
    console.error('[notify] load failed:', err instanceof Error ? err.message : String(err))
    return null
  }
}

// The org's white-label brand for email, or undefined when the org hasn't
// customized anything (→ generic Bevora Sign identity). Logo is intentionally not
// used in email (remote/inlined images are unreliable) — name + colour only.
function emailBrandFor(org: {
  name: string
  brandName: string | null
  brandColor: string | null
  logoKey: string | null
} | null): EmailBrand | undefined {
  if (!org) return undefined
  const b = resolveBrand(org)
  return b.customized ? { name: b.name, color: b.color } : undefined
}

/**
 * On "Send for signature": email each recipient their signing link. For
 * `parallel`, all recipients now; for `sequential`, ONLY the first (lowest
 * orderIndex) — the rest are emailed as their turn comes (notifyNextSequential).
 */
export async function notifyOnSend(documentId: string, baseUrl?: string | null): Promise<void> {
  const doc = await loadDoc(documentId)
  if (!doc) return
  const base = appBaseUrl(baseUrl)
  const senderName = doc.owner?.name ?? 'A sender'
  const brand = emailBrandFor(doc.org)

  const targets =
    doc.signingOrder === 'sequential' ? doc.recipients.slice(0, 1) : doc.recipients

  for (const r of targets) {
    const rendered = renderRequestEmail({
      recipientName: r.name,
      senderName,
      docName: doc.originalName,
      signUrl: signUrl(base, r.token),
      brand,
    })
    await deliver(documentId, 'request', r.email, rendered)
  }
}

/**
 * After a recipient signs but the document is NOT yet complete: for `sequential`
 * order, email the NEXT recipient (lowest orderIndex still pending) their link.
 * No-op for `parallel` (everyone was emailed at send time).
 */
export async function notifyNextSequential(documentId: string, baseUrl?: string | null): Promise<void> {
  const doc = await loadDoc(documentId)
  if (!doc || doc.signingOrder !== 'sequential') return
  const next = doc.recipients.find((r) => r.status === RecipientStatus.pending)
  if (!next) return
  const base = appBaseUrl(baseUrl)
  const rendered = renderRequestEmail({
    recipientName: next.name,
    senderName: doc.owner?.name ?? 'A sender',
    docName: doc.originalName,
    signUrl: signUrl(base, next.token),
    brand: emailBrandFor(doc.org),
  })
  await deliver(documentId, 'request', next.email, rendered)
}

/**
 * On ALL signed → completed: email the sender (link to the app) AND every
 * recipient (with the signed PDF attached). Attaching is best-effort — if the
 * signed blob can't be read, the notice still goes out without the attachment.
 */
export async function notifyCompleted(documentId: string, baseUrl?: string | null): Promise<void> {
  const doc = await loadDoc(documentId)
  if (!doc) return
  const base = appBaseUrl(baseUrl)

  let attachment: { filename: string; content: Buffer; contentType?: string }[] | undefined
  if (doc.signedKey) {
    try {
      const bytes = await getObject(doc.signedKey)
      attachment = [
        { filename: `${doc.originalName.replace(/\.pdf$/i, '')}-signed.pdf`, content: bytes, contentType: 'application/pdf' },
      ]
    } catch (err) {
      console.error('[notify] signed attachment read failed:', err instanceof Error ? err.message : String(err))
    }
  }

  const brand = emailBrandFor(doc.org)

  // Recipients: attach the signed copy.
  for (const r of doc.recipients) {
    const rendered = renderCompletedEmail({
      recipientName: r.name,
      docName: doc.originalName,
      attached: !!attachment,
      brand,
    })
    await deliver(documentId, 'completed', r.email, rendered, attachment)
  }

  // Sender: attach + link into the app.
  if (doc.owner?.email) {
    const rendered = renderCompletedEmail({
      recipientName: doc.owner.name ?? 'there',
      docName: doc.originalName,
      attached: !!attachment,
      appUrl: base ? docUrl(base, documentId) : undefined,
      brand,
    })
    await deliver(documentId, 'completed', doc.owner.email, rendered, attachment)
  }
}

/**
 * On decline: email the sender that `recipientId` declined.
 */
export async function notifyDeclined(
  documentId: string,
  recipientId: string,
  baseUrl?: string | null,
): Promise<void> {
  const doc = await loadDoc(documentId)
  if (!doc || !doc.owner?.email) return
  const decliner = doc.recipients.find((r) => r.id === recipientId)
  const base = appBaseUrl(baseUrl)
  const rendered = renderDeclinedEmail({
    senderName: doc.owner.name ?? 'there',
    recipientName: decliner?.name ?? 'A recipient',
    docName: doc.originalName,
    appUrl: base ? docUrl(base, documentId) : undefined,
    brand: emailBrandFor(doc.org),
  })
  await deliver(documentId, 'declined', doc.owner.email, rendered)
}

/**
 * Manual resend: re-send a pending recipient their signing link (reminder copy).
 * Returns the mailer result so the route can report success/failure. Never
 * throws. `not_found` when the recipient isn't a pending/viewed recipient of
 * this document.
 */
export async function notifyReminder(
  documentId: string,
  recipientId: string,
  baseUrl?: string | null,
): Promise<SendEmailResult | { sent: false; reason: 'not_found' }> {
  const doc = await loadDoc(documentId)
  if (!doc) return { sent: false, reason: 'not_found' }
  const r = doc.recipients.find((x) => x.id === recipientId)
  if (!r || (r.status !== RecipientStatus.pending && r.status !== RecipientStatus.viewed)) {
    return { sent: false, reason: 'not_found' }
  }
  const base = appBaseUrl(baseUrl)
  const rendered = renderRequestEmail({
    recipientName: r.name,
    senderName: doc.owner?.name ?? 'A sender',
    docName: doc.originalName,
    signUrl: signUrl(base, r.token),
    reminder: true,
    brand: emailBrandFor(doc.org),
  })
  return deliver(documentId, 'reminder', r.email, rendered)
}
