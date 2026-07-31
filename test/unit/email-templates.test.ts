import { describe, it, expect } from 'vitest'
import {
  renderRequestEmail,
  renderCompletedEmail,
  renderDeclinedEmail,
  renderTestEmail,
  renderTeamInviteEmail,
} from '../../src/lib/email-templates'

// The templates are pure — no DB, no I/O. We assert each produces a subject,
// non-empty HTML + plain-text, carries the Bevora Sign wordmark, and escapes
// interpolated user input (no HTML injection into the markup).

describe('email-templates', () => {
  it('renderRequestEmail: html + text, sign link, sender + doc names', () => {
    const r = renderRequestEmail({
      recipientName: 'Ann',
      senderName: 'Bob',
      docName: 'NDA.pdf',
      signUrl: 'https://app.example.com/sign/tok123',
    })
    expect(r.subject).toContain('Bob')
    expect(r.subject).toContain('NDA.pdf')
    expect(r.html).toContain('Bevora')
    expect(r.html).toContain('Sign')
    expect(r.html).toContain('Review')
    expect(r.html).toContain('https://app.example.com/sign/tok123')
    expect(r.text).toContain('https://app.example.com/sign/tok123')
    expect(r.text.length).toBeGreaterThan(0)
  })

  it('renderRequestEmail reminder variant changes subject + copy', () => {
    const r = renderRequestEmail({
      recipientName: 'Ann',
      senderName: 'Bob',
      docName: 'NDA.pdf',
      signUrl: 'https://x/sign/t',
      reminder: true,
    })
    expect(r.subject.toLowerCase()).toContain('reminder')
    expect(r.text.toLowerCase()).toContain('reminder')
  })

  it('renderCompletedEmail mentions the attachment when attached', () => {
    const r = renderCompletedEmail({ recipientName: 'Ann', docName: 'NDA.pdf', attached: true })
    expect(r.subject).toContain('NDA.pdf')
    expect(r.html).toContain('attached')
    expect(r.text).toContain('attached')
  })

  it('renderDeclinedEmail names the decliner + document', () => {
    const r = renderDeclinedEmail({ senderName: 'Bob', recipientName: 'Ann', docName: 'NDA.pdf' })
    expect(r.subject).toContain('Ann')
    expect(r.subject).toContain('NDA.pdf')
    expect(r.html).toContain('declined')
    expect(r.text).toContain('declined')
  })

  it('renderTestEmail produces subject + html + text', () => {
    const r = renderTestEmail()
    expect(r.subject.length).toBeGreaterThan(0)
    expect(r.html).toContain('Bevora')
    expect(r.html).toContain('Sign')
    expect(r.text.length).toBeGreaterThan(0)
  })

  it('white-label brand replaces the Bevora Sign wordmark + green (name/colour/footer)', () => {
    const r = renderRequestEmail({
      recipientName: 'Ann',
      senderName: 'Bob',
      docName: 'NDA.pdf',
      signUrl: 'https://x/sign/t',
      brand: { name: 'Acme Legal', color: '#123456' },
    })
    // Branded name + colour appear; button uses the brand colour.
    expect(r.html).toContain('Acme Legal')
    expect(r.html).toContain('#123456')
    // Footer + text sign-off carry the brand, not "Bevora Sign".
    expect(r.html).toContain('Sent by Acme Legal')
    expect(r.text).toContain('— Acme Legal')
    expect(r.text).not.toContain('— Bevora Sign')
    // The generic Bevora/Sign split wordmark markup is gone when branded.
    expect(r.html).not.toContain('Bevora<span')
  })

  it('a malicious brand colour cannot inject CSS (falls back to the brand gold)', () => {
    const r = renderCompletedEmail({
      recipientName: 'Ann',
      docName: 'NDA.pdf',
      appUrl: 'https://x/app',
      brand: { name: 'Acme', color: 'red;} body{display:none' },
    })
    expect(r.html).not.toContain('display:none')
    // Both fallback contexts must hold: the wordmark falls back to the core
    // brand gold, and the button — which carries white label text — falls back
    // to the deeper gold that clears AA contrast.
    expect(r.html).toContain('#b8860b') // wordmark accent
    expect(r.html).toContain('#976c0c') // button fill
  })

  it('no brand → generic Bevora Sign identity is preserved', () => {
    const r = renderDeclinedEmail({ senderName: 'Bob', recipientName: 'Ann', docName: 'NDA.pdf' })
    expect(r.html).toContain('Bevora')
    expect(r.html).toContain('Sent by Bevora Sign')
    expect(r.text).toContain('— Bevora Sign')
  })

  it('escapes interpolated user input (no raw HTML injection)', () => {
    const r = renderRequestEmail({
      recipientName: '<script>x</script>',
      senderName: 'Bob',
      docName: 'a&b<c>.pdf',
      signUrl: 'https://x/sign/t',
    })
    expect(r.html).not.toContain('<script>x</script>')
    expect(r.html).toContain('&lt;script&gt;')
    expect(r.html).toContain('a&amp;b&lt;c&gt;')
  })

  it('team invite carries the temp password + login link and escapes input', () => {
    const r = renderTeamInviteEmail({
      recipientName: 'Jane <x>',
      inviterName: 'Bob',
      orgName: 'Acme Pte Ltd',
      email: 'jane@acme.com',
      tempPassword: 'Tmp-Pass_123',
      loginUrl: 'https://x/login',
    })
    expect(r.subject).toContain('Acme Pte Ltd')
    expect(r.html).toContain('Tmp-Pass_123')
    expect(r.html).toContain('https://x/login')
    expect(r.text).toContain('Temporary password: Tmp-Pass_123')
    // User input is escaped (no raw HTML injection).
    expect(r.html).not.toContain('Jane <x>')
    expect(r.html).toContain('Jane &lt;x&gt;')
  })
})
