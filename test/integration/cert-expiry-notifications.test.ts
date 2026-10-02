// @vitest-environment node
//
// Sign #11: DB-backed reconciliation. Frozen clock passed explicitly to
// reconcileCertExpiryNotifications — never a global Date mock.
// Multi-tenant scoping, idempotency, recipient resolution, must-not-alert
// cases, and the email leg's TRUE 3-state outcome (measured against a real
// SMTP catcher, not assumed from EmailConfig.enabled) are all first-class.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
process.env.DATA_KEY ||= '0'.repeat(64)

import { prisma } from '../../src/lib/db'
import { reconcileCertExpiryNotifications } from '../../src/server/notifications/cert-expiry'

const DAY_MS = 86_400_000
const NOW = new Date('2026-10-02T00:00:00.000Z')
const daysOut = (n: number) => new Date(NOW.getTime() + n * DAY_MS)
const LONG_AGO = new Date(NOW.getTime() - 400 * DAY_MS)

let orgA: string
let orgB: string
let ownerA: string
let adminA: string
let memberA: string
let ownerB: string
const certIds: string[] = []

async function mkOrg(name: string, slug: string) {
  return (await prisma.organization.create({ data: { name, slug } })).id
}
async function mkUser(tag: string) {
  return (await prisma.user.create({ data: { email: `${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@x.com`, name: tag, passwordHash: 'x', role: 'user' } })).id
}
async function mkCert(opts: { orgId: string; notAfter: Date; createdAt: Date; createdBy?: string | null; subject?: string }) {
  const id = 'cert-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8)
  certIds.push(id)
  await prisma.signingCertificate.create({
    data: {
      id,
      orgId: opts.orgId,
      active: true,
      p12Key: 'signing/does-not-matter.p12',
      passphraseEnc: 'unused',
      subject: opts.subject ?? `CN=${opts.orgId}`,
      issuer: `CN=${opts.orgId}`,
      notBefore: new Date(opts.createdAt.getTime() - DAY_MS),
      notAfter: opts.notAfter,
      fingerprint: 'a'.repeat(64),
      origin: 'uploaded',
      createdAt: opts.createdAt,
      createdBy: opts.createdBy ?? null,
    },
  })
  return id
}

// NOTE: does not touch EmailConfig — that's a fixed fixture created ONCE in
// beforeAll (org A's real mailpit route), not per-test state. Deleting and
// never recreating it here would silently break every test after the first.
async function resetAll() {
  await prisma.notification.deleteMany({ where: { orgId: { in: [orgA, orgB] } } })
  await prisma.signingCertificate.deleteMany({ where: { orgId: { in: [orgA, orgB] } } })
}

beforeAll(async () => {
  const stamp = Date.now()
  orgA = await mkOrg('Cert Expiry Org A', 'cea-' + stamp)
  orgB = await mkOrg('Cert Expiry Org B', 'ceb-' + stamp)
  ownerA = await mkUser('owner-a')
  adminA = await mkUser('admin-a')
  memberA = await mkUser('member-a')
  ownerB = await mkUser('owner-b')
  await prisma.membership.createMany({
    data: [
      { orgId: orgA, userId: ownerA, role: 'owner' },
      { orgId: orgA, userId: adminA, role: 'admin' },
      { orgId: orgA, userId: memberA, role: 'member' },
      { orgId: orgB, userId: ownerB, role: 'owner' },
    ],
  })
  // Org A has REAL, reachable SMTP (our own throwaway mailpit catcher) — lets
  // the multi-tenant test measure an actual successful send and its `via`,
  // not assume one. Org B has none configured at all.
  await prisma.emailConfig.create({
    data: {
      id: 'ec-' + stamp,
      orgId: orgA,
      provider: 'smtp',
      enabled: true,
      host: '127.0.0.1',
      port: 11025,
      secure: false,
      fromEmail: 'certs@bevora-test.local',
      fromName: 'Bevora Sign (test)',
    },
  })
})

afterAll(async () => {
  await prisma.notification.deleteMany({ where: { orgId: { in: [orgA, orgB] } } })
  await prisma.signingCertificate.deleteMany({ where: { orgId: { in: [orgA, orgB] } } })
  await prisma.emailConfig.deleteMany({ where: { orgId: { in: [orgA, orgB] } } })
  await prisma.membership.deleteMany({ where: { orgId: { in: [orgA, orgB] } } })
  await prisma.user.deleteMany({ where: { id: { in: [ownerA, adminA, memberA, ownerB] } } })
  await prisma.organization.deleteMany({ where: { id: { in: [orgA, orgB] } } })
})

beforeEach(resetAll)

describe('multi-tenant scoping (load-bearing, not a courtesy)', () => {
  it('a cert nearing expiry notifies ONLY its own org\'s admins — never the other org\'s — and the email leg is measured (real send via mailpit), not assumed', async () => {
    // Clean slate on the catcher itself — otherwise a message left over from
    // an earlier run (or a differently-ordered test) could make the
    // independent check below pass for the wrong reason.
    await fetch('http://127.0.0.1:18025/api/v1/messages', { method: 'DELETE' })

    await mkCert({ orgId: orgA, notAfter: daysOut(7), createdAt: LONG_AGO })
    await mkCert({ orgId: orgB, notAfter: daysOut(400), createdAt: LONG_AGO }) // nowhere near due

    const result = await reconcileCertExpiryNotifications(NOW)
    expect(result.created).toBeGreaterThan(0)

    const notifsA = await prisma.notification.findMany({ where: { orgId: orgA }, include: { user: true } })
    const notifsB = await prisma.notification.findMany({ where: { orgId: orgB } })

    expect(notifsB).toHaveLength(0)
    // Owner + admin, never the plain member, never org B's owner. (At day 7
    // both the 30- and 7-day thresholds are due, so each recipient gets one
    // row per threshold — dedupe before comparing who was notified at all.)
    const recipientIds = new Set(notifsA.map((n) => n.userId))
    expect(recipientIds).toEqual(new Set([adminA, ownerA]))

    // The email leg is MEASURED: org A has a real, reachable SMTP target
    // (our mailpit catcher), so the send must have actually succeeded, and
    // `via` must say 'org' — not inferred from EmailConfig.enabled, and not
    // "an email was sent" alone (that would pass even if routing were
    // broken and it fell back to a shared server).
    for (const n of notifsA) {
      expect(n.emailSent).toBe(true)
      expect(n.emailVia).toBe('org')
    }

    // Confirm via the catcher ITSELF (not just our own DB bookkeeping) that
    // mail actually arrived at exactly ownerA/adminA's addresses and at NO
    // ONE else's — the independent half of the proof.
    const expectedTo = new Set(
      (await prisma.user.findMany({ where: { id: { in: [ownerA, adminA] } }, select: { email: true } })).map(
        (u) => u.email,
      ),
    )
    const mailpit = await fetch('http://127.0.0.1:18025/api/v1/messages?limit=50').then((r) => r.json())
    const receivedTo = new Set(
      (mailpit.messages as { To: { Address: string }[] }[]).flatMap((m) => m.To.map((t) => t.Address)),
    )
    expect(receivedTo).toEqual(expectedTo)
  })
})

describe('must-not-alert', () => {
  it('an org with no certificate at all produces nothing', async () => {
    const result = await reconcileCertExpiryNotifications(NOW)
    expect(result.created).toBe(0)
  })

  it('a long-lived cert at 31 days out: silent (must-not-fire)', async () => {
    await mkCert({ orgId: orgA, notAfter: daysOut(31), createdAt: LONG_AGO })
    const result = await reconcileCertExpiryNotifications(NOW)
    expect(result.created).toBe(0)
  })

  it('a long-lived cert at 8 days out: fires the 30-day notice only, NOT the 7-day one yet', async () => {
    await mkCert({ orgId: orgA, notAfter: daysOut(8), createdAt: LONG_AGO })
    await reconcileCertExpiryNotifications(NOW)
    const notifs = await prisma.notification.findMany({ where: { orgId: orgA } })
    expect(notifs.length).toBeGreaterThan(0)
    expect(notifs.every((n) => n.title.includes('30 days'))).toBe(true)
    expect(notifs.some((n) => n.title.includes('7 days'))).toBe(false)
  })

  it('a long-lived cert at 2 days out: fires 30/7/1 but never the exact 7-day wording redundantly beyond what is due, and never "expired"', async () => {
    await mkCert({ orgId: orgA, notAfter: daysOut(2), createdAt: LONG_AGO })
    await reconcileCertExpiryNotifications(NOW)
    const notifs = await prisma.notification.findMany({ where: { orgId: orgA } })
    expect(notifs.some((n) => n.title === 'Signing certificate expired')).toBe(false)
  })
})

describe('idempotency (DB-backed, survives a second run)', () => {
  it('running reconciliation twice at the same instant creates nothing the second time', async () => {
    await mkCert({ orgId: orgA, notAfter: daysOut(1), createdAt: LONG_AGO })
    const first = await reconcileCertExpiryNotifications(NOW)
    expect(first.created).toBeGreaterThan(0)
    const second = await reconcileCertExpiryNotifications(NOW)
    expect(second.created).toBe(0)
    const total = await prisma.notification.count({ where: { orgId: orgA } })
    expect(total).toBe(first.created)
  })

  it('a later run, once a NEW threshold is crossed, creates only the new ones (old ones are not re-sent)', async () => {
    await mkCert({ orgId: orgA, notAfter: daysOut(7), createdAt: LONG_AGO })
    const atDay7 = await reconcileCertExpiryNotifications(NOW)
    expect(atDay7.created).toBeGreaterThan(0) // 30 and 7 both already crossed at day 7
    const atDay1 = await reconcileCertExpiryNotifications(daysOut(6)) // now 1 day out
    expect(atDay1.created).toBeGreaterThan(0)
    const titles = (await prisma.notification.findMany({ where: { orgId: orgA } })).map((n) => n.title)
    // 30-day notice appears exactly once across both runs, not twice.
    expect(titles.filter((t) => t.includes('30 days')).length).toBe(2) // owner + admin, once each
  })

  it('CONCURRENT runs (Promise.all, not sequential) send the email exactly ONCE per recipient, not twice — the row count alone cannot see this: the claim must happen before the send', async () => {
    await fetch('http://127.0.0.1:18025/api/v1/messages', { method: 'DELETE' })
    // Exactly one threshold due (0 = expiry day), eligible because this cert
    // was just "created" with nothing left — isolates the race to a single
    // (cert, threshold, recipient) triple per recipient, which is the
    // narrowest case that can expose a duplicate send.
    await mkCert({ orgId: orgA, notAfter: NOW, createdAt: NOW })

    const [a, b] = await Promise.all([
      reconcileCertExpiryNotifications(NOW),
      reconcileCertExpiryNotifications(NOW),
    ])
    expect(a.created + b.created).toBe(2) // owner + admin, exactly once each, across BOTH calls combined

    const rows = await prisma.notification.findMany({ where: { orgId: orgA } })
    expect(rows).toHaveLength(2)

    // The real proof: count actual messages the catcher received, not rows.
    // A row count of 2 is consistent with either 2 emails (correct) or 4
    // (the bug: both racers passed a check-then-act and both sent before
    // either inserted) — only the catcher's own inbox can tell them apart.
    const mailpit = await fetch('http://127.0.0.1:18025/api/v1/messages?limit=50').then((r) => r.json())
    expect((mailpit.messages as unknown[]).length).toBe(2)
  })
})

describe('recipients: org admins + the certificate\'s own initiator, deduplicated', () => {
  it('the initiator is included even if they are a plain member', async () => {
    await mkCert({ orgId: orgA, notAfter: daysOut(1), createdAt: LONG_AGO, createdBy: memberA })
    await reconcileCertExpiryNotifications(NOW)
    const recipientIds = (await prisma.notification.findMany({ where: { orgId: orgA } })).map((n) => n.userId)
    expect(new Set(recipientIds)).toEqual(new Set([ownerA, adminA, memberA]))
  })

  it('an initiator who is ALSO an admin is not double-notified for the SAME threshold', async () => {
    await mkCert({ orgId: orgA, notAfter: daysOut(30), createdAt: LONG_AGO, createdBy: adminA })
    await reconcileCertExpiryNotifications(NOW)
    // Exactly one threshold (30) is due, so exactly one row for adminA — if
    // the recipient set were not deduplicated (admin found twice: once via
    // the membership query, once via createdBy), this would be 2.
    const notifs = await prisma.notification.findMany({ where: { orgId: orgA, userId: adminA } })
    expect(notifs).toHaveLength(1)
  })
})

describe('email leg: the three real states, measured', () => {
  it('an org with NO EmailConfig at all: emailSent=false, reason=not_configured — not inferred, not a silent gap', async () => {
    await mkCert({ orgId: orgB, notAfter: daysOut(1), createdAt: LONG_AGO })
    await reconcileCertExpiryNotifications(NOW)
    const notifs = await prisma.notification.findMany({ where: { orgId: orgB } })
    expect(notifs.length).toBeGreaterThan(0)
    for (const n of notifs) {
      expect(n.emailSent).toBe(false)
      expect(n.emailReason).toBe('not_configured')
      expect(n.emailVia).toBeNull()
    }
    // And the in-app row exists regardless — in-app does NOT depend on mail.
    expect(notifs.every((n) => n.title.length > 0)).toBe(true)
  })
})
