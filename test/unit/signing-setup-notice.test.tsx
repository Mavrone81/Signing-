import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

// The notice exists to be SEEN by an org with no certificate, and to be GONE
// otherwise. Both halves matter equally: a banner that never disappears trains
// people to ignore banners, and one that never appears is the same as not
// having built it.
//
// isSigningConfigured is mocked rather than seeded, because what is under test
// is the decision — show or not — not how a certificate is stored. The real
// function's own behaviour is covered where it lives.
const { isSigningConfiguredMock } = vi.hoisted(() => ({ isSigningConfiguredMock: vi.fn() }))
vi.mock('@/lib/signing-config', () => ({ isSigningConfigured: isSigningConfiguredMock }))

import { SigningSetupNotice } from '../../src/components/documents/SigningSetupNotice'

const ORG = 'org-1'
const owner = { orgId: ORG, orgRole: 'owner', isPlatformAdmin: false }
const admin = { orgId: ORG, orgRole: 'admin', isPlatformAdmin: false }
const member = { orgId: ORG, orgRole: 'member', isPlatformAdmin: false }

async function render(user: unknown): Promise<string> {
  const el = await SigningSetupNotice({ user: user as never })
  if (el === null) return ''
  return renderToStaticMarkup(el)
}

beforeEach(() => {
  isSigningConfiguredMock.mockReset()
})

describe('SigningSetupNotice', () => {
  it('shows to an owner whose org has no certificate, and links to where it is fixed', async () => {
    isSigningConfiguredMock.mockResolvedValue(false)
    const html = await render(owner)
    expect(html).toContain('Set up your signing certificate')
    expect(html).toContain('/settings/signing')
    // The honest consequence, not just a nudge: a reader cannot verify the doc.
    expect(html).toContain('not sealed')
  })

  it('shows to an admin too — the owner is not the only one who can act', async () => {
    isSigningConfiguredMock.mockResolvedValue(false)
    expect(await render(admin)).toContain('Set up your signing certificate')
  })

  it('DISAPPEARS once the org has a certificate', async () => {
    isSigningConfiguredMock.mockResolvedValue(true)
    expect(await render(owner)).toBe('')
  })

  it('never shows to a member, who could not act on it even if it did', async () => {
    isSigningConfiguredMock.mockResolvedValue(false)
    expect(await render(member)).toBe('')
    // And it does not even ask: no point querying on behalf of someone who
    // cannot see the answer.
    expect(isSigningConfiguredMock).not.toHaveBeenCalled()
  })

  it('never shows to a user with no organization', async () => {
    isSigningConfiguredMock.mockResolvedValue(false)
    expect(await render({ orgId: null, orgRole: null, isPlatformAdmin: false })).toBe('')
    expect(await render(null)).toBe('')
  })

  it('asks about the caller’s OWN org, never a hardcoded or absent one', async () => {
    isSigningConfiguredMock.mockResolvedValue(false)
    await render({ orgId: 'org-9', orgRole: 'owner', isPlatformAdmin: false })
    expect(isSigningConfiguredMock).toHaveBeenCalledWith('org-9')
  })
})
