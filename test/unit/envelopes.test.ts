import { describe, it, expect } from 'vitest'
import { deriveEnvelopeStatus, normalizeSigners } from '../../src/lib/envelopes'

describe('deriveEnvelopeStatus', () => {
  it('draft when nothing has been sent, including an empty envelope', () => {
    expect(deriveEnvelopeStatus([])).toBe('draft')
    expect(deriveEnvelopeStatus(['draft', 'draft'])).toBe('draft')
  })
  it('partial when some went out and some are still drafts', () => {
    expect(deriveEnvelopeStatus(['draft', 'sent'])).toBe('partial')
    expect(deriveEnvelopeStatus(['completed', 'draft'])).toBe('partial')
  })
  it('sent when everything went out and something is still open (declined counts as out)', () => {
    expect(deriveEnvelopeStatus(['sent', 'completed'])).toBe('sent')
    expect(deriveEnvelopeStatus(['declined', 'completed'])).toBe('sent')
  })
  it('completed when every document is completed or self-signed', () => {
    expect(deriveEnvelopeStatus(['completed', 'signed'])).toBe('completed')
  })
})

describe('normalizeSigners', () => {
  it('trims, lowercases emails, drops blank rows and duplicate emails', () => {
    expect(
      normalizeSigners([
        { name: ' Ann ', email: ' ANN@X.com ' },
        { name: '', email: '' },
        { name: 'Ann again', email: 'ann@x.com' },
        { name: 'Bob', email: 'bob@x.com' },
      ]),
    ).toEqual([
      { name: 'Ann', email: 'ann@x.com' },
      { name: 'Bob', email: 'bob@x.com' },
    ])
  })
  it('refuses a row with a name but no valid email, or an email but no name', () => {
    expect(normalizeSigners([{ name: 'Ann', email: 'not-an-email' }])).toBeNull()
    expect(normalizeSigners([{ name: '', email: 'ann@x.com' }])).toBeNull()
  })
})
