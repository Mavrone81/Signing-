import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock the config layer so the mailer can be exercised with NO database and NO
// SMTP server — we assert the not-configured no-op contract and that the lookup
// is made for exactly the org the send names.
const cfg = vi.hoisted(() => ({
  getActiveEmailConfig: vi.fn<(orgId: string | null) => Promise<null>>(async () => null),
  isEmailConfigured: vi.fn<(orgId: string | null) => Promise<boolean>>(async () => false),
}))
vi.mock('@/lib/email-config', () => cfg)

const msg = { to: 'someone@example.com', subject: 'Hi', html: '<p>Hi</p>', text: 'Hi' }

beforeEach(() => {
  cfg.getActiveEmailConfig.mockClear()
})

describe('mailer (email not configured)', () => {
  it('isEmailConfigured() reports false', async () => {
    const { isEmailConfigured } = await import('@/lib/mailer')
    expect(await isEmailConfigured('org_a')).toBe(false)
  })

  it('sendEmail() is a no-op that returns not_configured and never throws', async () => {
    const { sendEmail } = await import('@/lib/mailer')
    const res = await sendEmail({ orgId: 'org_a', ...msg })
    expect(res).toEqual({ sent: false, reason: 'not_configured' })
  })

  it('looks up the config for exactly the org the send names', async () => {
    const { sendEmail } = await import('@/lib/mailer')
    await sendEmail({ orgId: 'org_b', ...msg })
    expect(cfg.getActiveEmailConfig).toHaveBeenCalledTimes(1)
    expect(cfg.getActiveEmailConfig).toHaveBeenCalledWith('org_b')
  })

  it('a config read failure is reported, not thrown', async () => {
    cfg.getActiveEmailConfig.mockRejectedValueOnce(new Error('db down'))
    const { sendEmail } = await import('@/lib/mailer')
    const res = await sendEmail({ orgId: 'org_a', ...msg })
    expect(res).toMatchObject({ sent: false, reason: 'error' })
  })
})
