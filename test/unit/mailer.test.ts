import { describe, it, expect, vi } from 'vitest'

// Mock the config layer so the mailer can be exercised with NO database and NO
// SMTP server — we only assert the not-configured no-op contract here.
vi.mock('@/lib/email-config', () => ({
  getActiveEmailConfig: vi.fn(async () => null),
  isEmailConfigured: vi.fn(async () => false),
}))

describe('mailer (email not configured)', () => {
  it('isEmailConfigured() reports false', async () => {
    const { isEmailConfigured } = await import('@/lib/mailer')
    expect(await isEmailConfigured()).toBe(false)
  })

  it('sendEmail() is a no-op that returns not_configured and never throws', async () => {
    const { sendEmail } = await import('@/lib/mailer')
    const res = await sendEmail({
      to: 'someone@example.com',
      subject: 'Hi',
      html: '<p>Hi</p>',
      text: 'Hi',
    })
    expect(res).toEqual({ sent: false, reason: 'not_configured' })
  })
})
