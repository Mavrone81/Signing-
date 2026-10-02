'use server'

import { revalidatePath } from 'next/cache'
import { auth } from '@/auth'
import { prisma } from '@/lib/db'
import { isCertificateExpired } from '@/lib/pki'

export type NotificationView = {
  id: string
  title: string
  body: string
  href: string | null
  createdAt: string
  readAt: string | null
  // The DISPLAY state — not simply `readAt == null`. See below.
  unread: boolean
}

// Server-side read for the layout's bell. Scoped to the SESSION user only —
// a notification is addressed to one specific user id, never derived from
// anything the client supplies.
//
// `unread` is computed, not just `readAt == null`: a
// post-expiry cert_expiry notice (thresholdDays === 0) stays reported as
// unread, REGARDLESS of readAt, for as long as the certificate it names
// remains the org's active certificate AND is still expired. F1b made
// expiry fail-closed, so from day 0 this is an active outage, not a
// future-problem warning — a dismissed notice followed by silence until the
// next signing failure is exactly what Sign #11 exists to prevent.
// `readAt` itself is still written and still returned (it records that the
// user acknowledged it once); only the DISPLAYED unread state overrides it.
// Once the org replaces the certificate (the old one is deactivated by
// persistSigningCertificate's "deactivate previous, activate new"
// transaction), this override stops applying and `readAt` is respected
// again — the outage is over, so an ordinary dismissed notice is correct.
// Pre-expiry thresholds (30/7/1 days) are NOT touched by this: they keep
// the 4-point re-fire exactly as built — see cert-expiry-thresholds.ts for
// that design.
export async function getNotificationsForUser(
  userId: string,
  opts: { limit?: number } = {},
): Promise<{ unreadCount: number; recent: NotificationView[] }> {
  const all = await prisma.notification.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      title: true,
      body: true,
      href: true,
      createdAt: true,
      readAt: true,
      kind: true,
      subjectId: true,
      thresholdDays: true,
    },
  })

  const candidateCertIds = [
    ...new Set(
      all
        .filter((n) => n.readAt && n.kind === 'cert_expiry' && n.thresholdDays === 0 && n.subjectId)
        .map((n) => n.subjectId as string),
    ),
  ]
  const stillActiveExpired = new Set(
    candidateCertIds.length === 0
      ? []
      : (
          await prisma.signingCertificate.findMany({
            where: { id: { in: candidateCertIds }, active: true },
            select: { id: true, notAfter: true },
          })
        )
          .filter((c) => isCertificateExpired(c.notAfter))
          .map((c) => c.id),
  )

  const view: NotificationView[] = all.map((n) => ({
    id: n.id,
    title: n.title,
    body: n.body,
    href: n.href,
    createdAt: n.createdAt.toISOString(),
    readAt: n.readAt ? n.readAt.toISOString() : null,
    unread:
      n.readAt == null ||
      (n.kind === 'cert_expiry' &&
        n.thresholdDays === 0 &&
        !!n.subjectId &&
        stillActiveExpired.has(n.subjectId)),
  }))

  return {
    unreadCount: view.filter((n) => n.unread).length,
    recent: view.slice(0, opts.limit ?? 20),
  }
}

// Mark ONE notification read. Re-checks ownership server-side (the id comes
// from the client) — a user can only ever mark their OWN notification read,
// never guess another user's id to silence theirs.
export async function markNotificationRead(id: string): Promise<void> {
  const session = await auth()
  const userId = session?.user?.id
  if (!userId) return
  await prisma.notification.updateMany({
    where: { id, userId, readAt: null },
    data: { readAt: new Date() },
  })
  revalidatePath('/', 'layout')
}

export async function markAllNotificationsRead(): Promise<void> {
  const session = await auth()
  const userId = session?.user?.id
  if (!userId) return
  await prisma.notification.updateMany({
    where: { userId, readAt: null },
    data: { readAt: new Date() },
  })
  revalidatePath('/', 'layout')
}
