import { describe, it, expect } from 'vitest'
import { canAccessDocument, documentScope } from '../../src/lib/rbac'

// Owner-only documents: a document is reachable only by the person who
// uploaded it, and only inside its own org. Org owners and admins get no extra
// document access — the org match is a tenancy guard, not a grant.
const O = 'org1'
describe('canAccessDocument', () => {
  it('denies an org owner or admin a document they did not upload', () => {
    expect(canAccessDocument({ id: 'a', orgId: O, orgRole: 'owner' }, { ownerId: 'z', orgId: O })).toBe(false)
    expect(canAccessDocument({ id: 'a', orgId: O, orgRole: 'admin' }, { ownerId: 'z', orgId: O })).toBe(false)
  })
  it('allows every role its own documents', () => {
    for (const orgRole of ['owner', 'admin', 'member'] as const) {
      expect(canAccessDocument({ id: 'u', orgId: O, orgRole }, { ownerId: 'u', orgId: O })).toBe(true)
    }
  })
  it('a member sees their own documents only', () => {
    expect(canAccessDocument({ id: 'u', orgId: O, orgRole: 'member' }, { ownerId: 'x', orgId: O })).toBe(false)
  })
  it('denies cross-org access even to the uploader', () => {
    expect(canAccessDocument({ id: 'a', orgId: O, orgRole: 'owner' }, { ownerId: 'a', orgId: 'org2' })).toBe(false)
  })
  it('denies a user with no org', () => {
    expect(canAccessDocument({ id: 'u', orgId: null, orgRole: null }, { ownerId: 'u', orgId: O })).toBe(false)
  })
})

describe('documentScope', () => {
  it('scopes a listing to the caller’s own documents in their org, whatever the role', () => {
    for (const orgRole of ['owner', 'admin', 'member'] as const) {
      expect(documentScope({ id: 'u', orgId: O, orgRole })).toEqual({ orgId: O, ownerId: 'u' })
    }
  })
  it('returns null for a user with no org, so callers list nothing', () => {
    expect(documentScope({ id: 'u', orgId: null, orgRole: null })).toBeNull()
  })
})
