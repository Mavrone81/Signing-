import { describe, it, expect } from 'vitest'
import { canManageOrgSettings } from '../../src/lib/org-settings'

describe('canManageOrgSettings', () => {
  it('allows the org’s owners and admins', () => {
    expect(canManageOrgSettings({ orgId: 'o', orgRole: 'owner' })).toBe(true)
    expect(canManageOrgSettings({ orgId: 'o', orgRole: 'admin' })).toBe(true)
  })
  it('allows a platform admin within their own org, whatever their org role', () => {
    expect(canManageOrgSettings({ orgId: 'o', orgRole: 'member', isPlatformAdmin: true })).toBe(true)
  })
  it('refuses a plain member', () => {
    expect(canManageOrgSettings({ orgId: 'o', orgRole: 'member' })).toBe(false)
  })
  it('refuses anyone with no org, including a platform admin', () => {
    expect(canManageOrgSettings({ orgId: null, orgRole: null, isPlatformAdmin: true })).toBe(false)
    expect(canManageOrgSettings(null)).toBe(false)
  })
})
