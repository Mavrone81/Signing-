// @vitest-environment node
//
// Sign #11: the 4-point pre-expiry re-fire (30/7/1 days) stays
// exactly as built — dismissing one doesn't suppress the next, and a single
// notice does not stay lit for the whole window. But POST-expiry (threshold
// 0 onward) is different: F1b made expiry fail-closed, so from day 0 this
// isn't a future-problem warning anymore, it's an active outage. The
// indicator must PERSIST and not be dismissable-to-silence while the
// certificate remains expired and unreplaced — overriding `readAt` in the
// DISPLAY layer, not refusing the mark-read write itself (the user's
// acknowledgment is still recorded; it just doesn't silence the badge while
// the hard condition holds).
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
process.env.DATA_KEY ||= '0'.repeat(64)

// src/server/notifications/actions.ts also exports server actions that
// import '@/auth' and 'next/cache' at module scope — mocked here (unused by
// this file's tests) purely so the module graph loads cleanly outside a real
// Next.js request, matching the pattern other integration tests already use.
vi.mock('@/auth', () => ({ auth: () => Promise.resolve(null) }))
vi.mock('next/cache', () => ({ revalidatePath: () => {} }))

import { prisma } from '../../src/lib/db'
import { getNotificationsForUser } from '../../src/server/notifications/actions'

let org: string
let admin: string

async function mkCert(opts: { notAfter: Date; active?: boolean }) {
  const id = 'cert-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8)
  await prisma.signingCertificate.create({
    data: {
      id,
      orgId: org,
      active: opts.active ?? true,
      p12Key: 'signing/does-not-matter.p12',
      passphraseEnc: 'unused',
      subject: 'CN=Persistence Test',
      issuer: 'CN=Persistence Test',
      notBefore: new Date(Date.now() - 400 * 86_400_000),
      notAfter: opts.notAfter,
      fingerprint: 'b'.repeat(64),
      origin: 'uploaded',
    },
  })
  return id
}

async function mkNotification(opts: {
  subjectId: string
  thresholdDays: number
  readAt?: Date | null
}) {
  const id = 'notif-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8)
  await prisma.notification.create({
    data: {
      id,
      orgId: org,
      userId: admin,
      kind: 'cert_expiry',
      dedupeKey: id, // unique is all that matters here
      subjectId: opts.subjectId,
      thresholdDays: opts.thresholdDays,
      title: 't',
      body: 'b',
      readAt: opts.readAt ?? null,
    },
  })
  return id
}

beforeAll(async () => {
  const stamp = Date.now()
  org = (await prisma.organization.create({ data: { name: 'Persistence Org', slug: 'persist-' + stamp } })).id
  admin = (await prisma.user.create({ data: { email: `persist-admin-${stamp}@x.com`, name: 'admin', passwordHash: 'x', role: 'user' } })).id
  await prisma.membership.create({ data: { orgId: org, userId: admin, role: 'admin' } })
})

afterAll(async () => {
  await prisma.notification.deleteMany({ where: { orgId: org } })
  await prisma.signingCertificate.deleteMany({ where: { orgId: org } })
  await prisma.membership.deleteMany({ where: { orgId: org } })
  await prisma.user.deleteMany({ where: { id: admin } })
  await prisma.organization.deleteMany({ where: { id: org } })
})

beforeEach(async () => {
  await prisma.notification.deleteMany({ where: { orgId: org } })
  await prisma.signingCertificate.deleteMany({ where: { orgId: org } })
})

describe('post-expiry (threshold 0): marking read does NOT silence the badge while the cert is still active and expired', () => {
  it('a read threshold-0 notification for a still-active, still-expired cert is reported UNREAD', async () => {
    const certId = await mkCert({ notAfter: new Date(Date.now() - 86_400_000), active: true })
    const notifId = await mkNotification({ subjectId: certId, thresholdDays: 0, readAt: new Date() })

    const { unreadCount, recent } = await getNotificationsForUser(admin)
    expect(unreadCount).toBe(1)
    expect(recent.find((n) => n.id === notifId)?.unread).toBe(true)
  })

  it('marking it read via the server action still does not silence it, for the same reason', async () => {
    const certId = await mkCert({ notAfter: new Date(Date.now() - 86_400_000), active: true })
    const notifId = await mkNotification({ subjectId: certId, thresholdDays: 0, readAt: null })

    expect((await getNotificationsForUser(admin)).unreadCount).toBe(1)
    // markNotificationRead requires a session; call the DB update it performs
    // directly is not available here, so exercise it via a raw update that
    // mirrors exactly what the action does (readAt set), then re-check
    // getNotificationsForUser's override — this isolates the DISPLAY-layer
    // behavior under test from auth plumbing, which is covered separately.
    await prisma.notification.update({ where: { id: notifId }, data: { readAt: new Date() } })

    const { unreadCount, recent } = await getNotificationsForUser(admin)
    expect(unreadCount).toBe(1)
    expect(recent.find((n) => n.id === notifId)?.unread).toBe(true)
  })

  it('once the org REPLACES the certificate (old one deactivated), the old notification reverts to respecting readAt', async () => {
    const certId = await mkCert({ notAfter: new Date(Date.now() - 86_400_000), active: false }) // already deactivated, as replacement would do
    const notifId = await mkNotification({ subjectId: certId, thresholdDays: 0, readAt: new Date() })

    const { unreadCount, recent } = await getNotificationsForUser(admin)
    expect(unreadCount).toBe(0)
    expect(recent.find((n) => n.id === notifId)?.unread).toBe(false)
  })

  it('an UNREAD threshold-0 notification is unread regardless (no regression on the normal case)', async () => {
    const certId = await mkCert({ notAfter: new Date(Date.now() - 86_400_000), active: true })
    await mkNotification({ subjectId: certId, thresholdDays: 0, readAt: null })
    expect((await getNotificationsForUser(admin)).unreadCount).toBe(1)
  })
})

describe('pre-expiry (threshold > 0): quiet-middle behavior is UNCHANGED — reading one does silence it', () => {
  it('a read 30-day (or 7/1-day) notification stays read, even though the cert is still inside that window', async () => {
    const certId = await mkCert({ notAfter: new Date(Date.now() + 10 * 86_400_000), active: true }) // still 10 days out, well inside a 30-day warning
    const notifId = await mkNotification({ subjectId: certId, thresholdDays: 30, readAt: new Date() })

    const { unreadCount, recent } = await getNotificationsForUser(admin)
    expect(unreadCount).toBe(0)
    expect(recent.find((n) => n.id === notifId)?.unread).toBe(false)
  })
})
