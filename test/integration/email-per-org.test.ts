// @vitest-environment node
//
// Per-org SMTP with a shared fallback, against the real dev Postgres. Proves:
// each org resolves to its own server, else the shared one, else nothing; the
// cache is per org (org A's server never answers for org B); saving the shared
// server reaches every org that falls back to it; the settings actions take the
// org from the SESSION (never the form) and refuse a plain member; and the test
// email goes to the address the admin chose (blank = their own), reporting the
// ACTUAL recipient and the server that carried it.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
process.env.DATA_KEY ||= '0'.repeat(64)

const authMock = vi.hoisted(() => ({ session: null as unknown }))
vi.mock('@/auth', () => ({ auth: () => Promise.resolve(authMock.session) }))
vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw Object.assign(new Error('REDIRECT'), { url })
  },
}))
vi.mock('next/cache', () => ({ revalidatePath: () => {} }))

import { prisma } from '../../src/lib/db'
import {
  getActiveEmailConfig,
  invalidateEmailConfigCache,
  describeEmailRoute,
} from '../../src/lib/email-config'
import {
  saveEmailConfig,
  saveSharedEmailConfig,
  sendTestEmail,
} from '../../src/app/(app)/settings/email/actions'

let orgA: string
let orgB: string
let ownerA: string
let memberA: string
let platformAdmin: string
// A shared row the dev DB already had, restored after the suite.
let sharedBefore: Awaited<ReturnType<typeof prisma.emailConfig.findFirst>> = null

const stamp = Date.now()
const ownerEmail = `email-owner-a-${stamp}@x.com`

async function run(session: unknown, action: () => Promise<void>): Promise<string | undefined> {
  authMock.session = session
  try {
    await action()
  } catch (e) {
    return (e as { url?: string }).url
  }
  return undefined
}

function smtpForm(fields: Record<string, string>): FormData {
  const fd = new FormData()
  for (const [k, v] of Object.entries(fields)) fd.set(k, v)
  return fd
}

const ownerSession = () => ({ user: { id: ownerA, email: ownerEmail, orgId: orgA, orgRole: 'owner', isPlatformAdmin: false } })

beforeAll(async () => {
  orgA = (await prisma.organization.create({ data: { name: 'Mail A', slug: 'mail-a-' + stamp } })).id
  orgB = (await prisma.organization.create({ data: { name: 'Mail B', slug: 'mail-b-' + stamp } })).id
  const mk = async (email: string, isPlatformAdmin = false) =>
    (await prisma.user.create({ data: { email, name: email, passwordHash: 'x', role: 'user', isPlatformAdmin } })).id
  ownerA = await mk(ownerEmail)
  memberA = await mk(`email-member-a-${stamp}@x.com`)
  platformAdmin = await mk(`email-pa-${stamp}@x.com`, true)
  await prisma.membership.createMany({
    data: [
      { orgId: orgA, userId: ownerA, role: 'owner' },
      { orgId: orgA, userId: memberA, role: 'member' },
      { orgId: orgB, userId: platformAdmin, role: 'member' },
    ],
  })
  // The dev DB may already hold a shared row; keep it and restore it afterwards.
  sharedBefore = await prisma.emailConfig.findFirst({ where: { orgId: null } })
})

afterAll(async () => {
  await prisma.emailConfig.deleteMany({ where: { orgId: { in: [orgA, orgB] } } })
  await prisma.emailConfig.deleteMany({ where: { orgId: null } })
  if (sharedBefore) await prisma.emailConfig.create({ data: sharedBefore })
  await prisma.user.deleteMany({ where: { id: { in: [ownerA, memberA, platformAdmin] } } })
  await prisma.organization.deleteMany({ where: { id: { in: [orgA, orgB] } } })
  invalidateEmailConfigCache()
})

beforeEach(async () => {
  await prisma.emailConfig.deleteMany({ where: { orgId: { in: [orgA, orgB] } } })
  await prisma.emailConfig.deleteMany({ where: { orgId: null } })
  invalidateEmailConfigCache()
})

const SHARED = { enabled: 'on', host: 'smtp.shared.test', port: '587', fromEmail: 'no-reply@shared.test' }
const OWN_A = { enabled: 'on', host: 'smtp.a.test', port: '465', secure: 'on', fromEmail: 'mail@a.test', password: 'pw-a' }

describe('resolution: own server, else shared, else nothing', () => {
  it('sends nothing when no server is set up', async () => {
    expect(await getActiveEmailConfig(orgA)).toBeNull()
    expect(await describeEmailRoute(orgA)).toBeNull()
  })

  it('an org with its own server uses it; an org without falls back to shared', async () => {
    await run({ user: { id: platformAdmin, orgId: orgB, orgRole: 'member', isPlatformAdmin: true } }, () =>
      saveSharedEmailConfig(smtpForm(SHARED)),
    )
    expect(await run(ownerSession(), () => saveEmailConfig(smtpForm(OWN_A)))).toBe('/settings/email?saved=org')

    const a = await getActiveEmailConfig(orgA)
    const b = await getActiveEmailConfig(orgB)
    expect(a).toMatchObject({ via: 'org', host: 'smtp.a.test', fromEmail: 'mail@a.test', password: 'pw-a' })
    expect(b).toMatchObject({ via: 'shared', host: 'smtp.shared.test', fromEmail: 'no-reply@shared.test' })
  })

  it('turning an org’s own server off sends it back to the shared server', async () => {
    await run({ user: { id: platformAdmin, orgId: orgB, orgRole: 'member', isPlatformAdmin: true } }, () =>
      saveSharedEmailConfig(smtpForm(SHARED)),
    )
    await run(ownerSession(), () => saveEmailConfig(smtpForm(OWN_A)))
    const disabled = smtpForm(OWN_A)
    disabled.delete('enabled')
    await run(ownerSession(), () => saveEmailConfig(disabled))
    expect(await getActiveEmailConfig(orgA)).toMatchObject({ via: 'shared' })
  })
})

describe('cache is per org', () => {
  it('org A’s cached server never answers for org B, and a shared save reaches everyone', async () => {
    await run(ownerSession(), () => saveEmailConfig(smtpForm(OWN_A)))
    // Warm both entries: A resolves to its own server, B to nothing.
    expect(await getActiveEmailConfig(orgA)).toMatchObject({ via: 'org' })
    expect(await getActiveEmailConfig(orgB)).toBeNull()

    // Saving the shared server clears every entry, so B picks it up immediately.
    await run({ user: { id: platformAdmin, orgId: orgB, orgRole: 'member', isPlatformAdmin: true } }, () =>
      saveSharedEmailConfig(smtpForm(SHARED)),
    )
    expect(await getActiveEmailConfig(orgB)).toMatchObject({ via: 'shared' })
    expect(await getActiveEmailConfig(orgA)).toMatchObject({ via: 'org' })
  })
})

describe('settings actions: gate and tenancy', () => {
  it('a plain member is redirected and nothing is written', async () => {
    const to = await run({ user: { id: memberA, orgId: orgA, orgRole: 'member', isPlatformAdmin: false } }, () =>
      saveEmailConfig(smtpForm(OWN_A)),
    )
    expect(to).toBe('/documents')
    expect(await prisma.emailConfig.count({ where: { orgId: orgA } })).toBe(0)
  })

  it('writes the session’s org even if the form names another org', async () => {
    await run(ownerSession(), () => saveEmailConfig(smtpForm({ ...OWN_A, orgId: orgB })))
    expect(await prisma.emailConfig.count({ where: { orgId: orgA } })).toBe(1)
    expect(await prisma.emailConfig.count({ where: { orgId: orgB } })).toBe(0)
  })

  it('an org owner cannot save the shared server', async () => {
    expect(await run(ownerSession(), () => saveSharedEmailConfig(smtpForm(SHARED)))).toBe('/documents')
    expect(await prisma.emailConfig.count({ where: { orgId: null } })).toBe(0)
  })

  it('a blank password on save keeps the stored one', async () => {
    await run(ownerSession(), () => saveEmailConfig(smtpForm(OWN_A)))
    await run(ownerSession(), () => saveEmailConfig(smtpForm({ ...OWN_A, password: '' })))
    expect((await getActiveEmailConfig(orgA))?.password).toBe('pw-a')
  })
})

// The test email's recipient is the signed-in account's own address and is not
// a parameter. These tests assert that from the SERVER's side, submitting a
// recipient anyway — which is what reaches the action regardless of what the
// page renders, since removing an input does not stop a form being posted.
describe('test email recipient', () => {
  it('sends to the admin’s own address and reports it', async () => {
    const to = await run(ownerSession(), () => sendTestEmail(smtpForm({})))
    // No server set up → fails, but the redirect still names the real recipient.
    expect(to).toBe(`/settings/email?test=fail&reason=not_configured&to=${encodeURIComponent(ownerEmail)}`)
  })

  it('IGNORES a submitted address and still sends to the admin’s own', async () => {
    const to = await run(ownerSession(), () => sendTestEmail(smtpForm({ to: '  Someone@Example.COM ' })))
    expect(to).toContain(`to=${encodeURIComponent(ownerEmail)}`)
    expect(to).not.toContain('someone%40example.com')
  })

  it('IGNORES a submitted address even when it is unparseable, rather than failing on it', async () => {
    // The old behaviour refused this with `bad_recipient`. There is no longer a
    // submitted address to be invalid, so the run proceeds to the admin's own.
    const to = await run(ownerSession(), () => sendTestEmail(smtpForm({ to: 'not an email' })))
    expect(to).toContain(`to=${encodeURIComponent(ownerEmail)}`)
    expect(to).not.toContain('bad_recipient')
  })

  it('reports the server that carried the attempt', async () => {
    await run({ user: { id: platformAdmin, orgId: orgB, orgRole: 'member', isPlatformAdmin: true } }, () =>
      saveSharedEmailConfig(smtpForm({ ...SHARED, host: '127.0.0.1', port: '1' })),
    )
    const to = await run(ownerSession(), () => sendTestEmail(smtpForm({ to: 'x@example.com' })))
    // Port 1 refuses the connection: an error, carried by the shared server —
    // and addressed to the admin, not to the address that was submitted.
    expect(to).toMatch(
      new RegExp(`test=fail&reason=error&to=${encodeURIComponent(encodeURIComponent(ownerEmail))}&via=shared$`),
    )
  })

  it('an account with no email address sends nothing at all', async () => {
    const to = await run(
      { user: { id: ownerA, email: null, orgId: orgA, orgRole: 'owner', isPlatformAdmin: false } },
      () => sendTestEmail(smtpForm({ to: 'someone@example.com' })),
    )
    expect(to).toBe('/settings/email?test=fail&reason=no_admin_email')
  })
})
