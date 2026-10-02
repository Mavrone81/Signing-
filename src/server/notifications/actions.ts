'use server'

import { revalidatePath } from 'next/cache'
import { auth } from '@/auth'
import { prisma } from '@/lib/db'

export type NotificationView = {
  id: string
  title: string
  body: string
  href: string | null
  createdAt: string
  readAt: string | null
}

// Server-side read for the layout's bell. Scoped to the SESSION user only —
// a notification is addressed to one specific user id, never derived from
// anything the client supplies.
export async function getNotificationsForUser(
  userId: string,
  opts: { limit?: number } = {},
): Promise<{ unreadCount: number; recent: NotificationView[] }> {
  const [unreadCount, recent] = await Promise.all([
    prisma.notification.count({ where: { userId, readAt: null } }),
    prisma.notification.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: opts.limit ?? 20,
      select: { id: true, title: true, body: true, href: true, createdAt: true, readAt: true },
    }),
  ])
  return {
    unreadCount,
    recent: recent.map((n) => ({
      ...n,
      createdAt: n.createdAt.toISOString(),
      readAt: n.readAt ? n.readAt.toISOString() : null,
    })),
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
