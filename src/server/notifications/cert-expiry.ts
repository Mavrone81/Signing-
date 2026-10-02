// Sign #11: certificate-expiry warnings, as reconciliation over state rather
// than a one-shot date-triggered event. A fire-once job is lost forever if
// the process is down at the exact trigger moment — which is exactly when a
// deploy happens — so every run asks fresh: "which certs are inside a
// threshold, and which (cert, threshold, recipient) triples have not yet
// been notified?" Idempotency/recovery state lives in the DATABASE
// (Notification.dedupeKey, unique) — never in process memory, which would
// die on restart and double-send across instances.
//
// Multi-tenant scoping is load-bearing, not a courtesy: a notice about org
// A's certificate reaching org B's admin is a disclosure, the same shape as
// the cross-tenant sealing risk this codebase already had. Every recipient
// here is resolved FROM the certificate's own orgId, never from a caller-
// supplied one.
import { prisma } from '@/lib/db'
import { sendEmail } from '@/lib/mailer'
import { appBaseUrl } from '@/server/documents/notify'
import { dueThresholds, type ThresholdDays } from './cert-expiry-thresholds'

type CertRow = {
  id: string
  orgId: string
  notAfter: Date
  createdAt: Date
  createdBy: string | null
  subject: string
}

// Recipients for one certificate: that ORG's owners/admins, plus whichever
// user generated/uploaded this specific certificate (even if they have since
// been demoted to member, or if generation predates the current admin set —
// the person who configured it still needs to know it's expiring),
// deduplicated by user id. Resolved strictly from `cert.orgId`.
async function recipientsFor(cert: CertRow): Promise<{ id: string; email: string }[]> {
  const admins = await prisma.membership.findMany({
    where: { orgId: cert.orgId, role: { in: ['owner', 'admin'] } },
    select: { user: { select: { id: true, email: true } } },
  })
  const byId = new Map(admins.map((m) => [m.user.id, m.user]))
  if (cert.createdBy && !byId.has(cert.createdBy)) {
    const initiator = await prisma.user.findUnique({
      where: { id: cert.createdBy },
      select: { id: true, email: true },
    })
    if (initiator) byId.set(initiator.id, initiator)
  }
  return [...byId.values()]
}

function dedupeKey(certId: string, threshold: ThresholdDays, userId: string): string {
  return `cert_expiry:${certId}:${threshold}:${userId}`
}

function copyFor(threshold: ThresholdDays, cert: CertRow): { title: string; body: string } {
  const subject = cert.subject || 'your signing certificate'
  if (threshold === 0) {
    return {
      title: 'Signing certificate expired',
      body: `${subject} has expired. Documents can no longer be sealed for this organization until it is replaced.`,
    }
  }
  return {
    title: `Signing certificate expiring in ${threshold} day${threshold === 1 ? '' : 's'}`,
    body: `${subject} expires in ${threshold} day${threshold === 1 ? '' : 's'}. Replace it in Settings -> Signing before then to avoid an interruption.`,
  }
}

// One reconciliation pass over EVERY active, non-null-org certificate.
// `now` is an injected clock (default the real one) — see
// cert-expiry-thresholds.ts for why this matters for testability; it also
// lets an operator re-run this deterministically against a specific instant
// if needed.
//
// The in-app row is ALWAYS created first and does not depend on the email
// leg succeeding: either a mail-failure signal someone actually sees, or
// don't make in-app depend on mail — this is the "don't depend on it at
// all" branch, since the in-app row IS that signal, unconditionally.
// Email is attempted as a real send via the SAME
// sendEmail() the rest of the app already uses — no new mail path is built
// for this — and its TRUE outcome (sent / not_configured / error, plus
// which route) is stored on the row, never inferred from EmailConfig.enabled.
export async function reconcileCertExpiryNotifications(now: Date = new Date()): Promise<{
  created: number
}> {
  const certs = await prisma.signingCertificate.findMany({
    where: { active: true, orgId: { not: null } },
    select: { id: true, orgId: true, notAfter: true, createdAt: true, createdBy: true, subject: true },
  })

  let created = 0
  const base = appBaseUrl()

  for (const row of certs) {
    const cert: CertRow = { ...row, orgId: row.orgId! }
    const due = dueThresholds(cert, now)
    if (due.length === 0) continue

    const recipients = await recipientsFor(cert)
    for (const threshold of due) {
      const { title, body } = copyFor(threshold, cert)
      for (const recipient of recipients) {
        const key = dedupeKey(cert.id, threshold, recipient.id)
        const already = await prisma.notification.findUnique({ where: { dedupeKey: key } })
        if (already) continue

        const emailResult = await sendEmail({
          orgId: cert.orgId,
          to: recipient.email,
          subject: title,
          html: `<p>${body}</p>`,
          text: body,
        })

        try {
          await prisma.notification.create({
            data: {
              orgId: cert.orgId,
              userId: recipient.id,
              kind: 'cert_expiry',
              dedupeKey: key,
              title,
              body,
              href: `${base}/settings/signing`,
              emailSent: emailResult.sent,
              emailReason: emailResult.sent ? null : emailResult.reason,
              emailVia: emailResult.sent ? emailResult.via : null,
            },
          })
          created += 1
        } catch (err) {
          // P2002 (unique violation on dedupeKey): a concurrent reconciliation
          // run already won this exact (cert, threshold, recipient) — not an
          // error, the idempotency guarantee working as designed. Anything
          // else is a real failure and must not be swallowed.
          const code = (err as { code?: string } | null)?.code
          if (code !== 'P2002') throw err
        }
      }
    }
  }

  return { created }
}
