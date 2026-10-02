import { describe, it, expect } from 'vitest'
import { normalizeInviteMessage, DEFAULT_INVITE_MESSAGE, MAX_INVITE_MESSAGE } from '../../src/lib/invite-message'
import { renderRequestEmail } from '../../src/lib/email-templates'

describe('normalizeInviteMessage', () => {
  it('trims and keeps a real note', () => {
    expect(normalizeInviteMessage('  Hello there  ')).toBe('Hello there')
  })
  it('an empty or whitespace note means no note', () => {
    expect(normalizeInviteMessage('')).toBeNull()
    expect(normalizeInviteMessage('   \n ')).toBeNull()
  })
  it('anything that is not a string means no note', () => {
    expect(normalizeInviteMessage(undefined)).toBeNull()
    expect(normalizeInviteMessage(42)).toBeNull()
  })
  it('caps the length and normalises line endings', () => {
    expect(normalizeInviteMessage('x'.repeat(MAX_INVITE_MESSAGE + 50))).toHaveLength(MAX_INVITE_MESSAGE)
    expect(normalizeInviteMessage('a\r\nb')).toBe('a\nb')
  })
  it('the default note is itself a valid note', () => {
    expect(normalizeInviteMessage(DEFAULT_INVITE_MESSAGE)).toBe(DEFAULT_INVITE_MESSAGE)
  })
})

describe('invitation email with a note', () => {
  const base = { recipientName: 'Ann', senderName: 'Bob', docName: 'Lease.pdf', signUrl: 'https://x/sign/t' }

  it('shows the note, attributed to the sender, in html and text', () => {
    const r = renderRequestEmail({ ...base, message: 'Page 3 needs initials.\nThanks!' })
    expect(r.html).toContain('Message from Bob')
    expect(r.html).toContain('Page 3 needs initials.<br>Thanks!')
    expect(r.text).toContain('Message from Bob:\nPage 3 needs initials.\nThanks!')
  })

  it('escapes the note so it cannot inject markup', () => {
    const r = renderRequestEmail({ ...base, message: '<a href="https://evil">click</a>' })
    expect(r.html).not.toContain('<a href="https://evil">')
    expect(r.html).toContain('&lt;a href=')
  })

  it('no note → no note block', () => {
    expect(renderRequestEmail({ ...base, message: null }).html).not.toContain('Message from')
    expect(renderRequestEmail(base).text).not.toContain('Message from')
  })

  it('a reminder repeats the note', () => {
    expect(renderRequestEmail({ ...base, reminder: true, message: 'Due Friday' }).html).toContain('Due Friday')
  })
})
