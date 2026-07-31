import { describe,it,expect } from 'vitest'
import { canAccessDocument } from '../../src/lib/rbac'

const O = 'org1'
describe('canAccessDocument', () => {
  it('org owner/admin sees all docs in their org', () => {
    expect(canAccessDocument({id:'a',orgId:O,orgRole:'owner'},{ownerId:'z',orgId:O})).toBe(true)
    expect(canAccessDocument({id:'a',orgId:O,orgRole:'admin'},{ownerId:'z',orgId:O})).toBe(true)
  })
  it('member sees own docs only, within the org', () => {
    expect(canAccessDocument({id:'u',orgId:O,orgRole:'member'},{ownerId:'u',orgId:O})).toBe(true)
    expect(canAccessDocument({id:'u',orgId:O,orgRole:'member'},{ownerId:'x',orgId:O})).toBe(false)
  })
  it('denies cross-org access even for an owner', () => {
    expect(canAccessDocument({id:'a',orgId:O,orgRole:'owner'},{ownerId:'a',orgId:'org2'})).toBe(false)
  })
  it('denies a user with no org (null)', () => {
    expect(canAccessDocument({id:'u',orgId:null,orgRole:null},{ownerId:'u',orgId:O})).toBe(false)
  })
})
