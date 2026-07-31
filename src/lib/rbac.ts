import type { OrgRole } from '@prisma/client'

// Tenant-scoped document access. A document is reachable ONLY within its own
// organization: the acting user's org must match the document's org, AND the
// user must either be an org owner/admin (sees every doc in the org) or the
// document's own owner (a plain member sees only their own docs).
//
// A user with no membership (orgId === null) can never match a document's org,
// so they are denied everywhere — a null org degrades to "no document access",
// never a crash.
export function canAccessDocument(
  u: { id: string; orgId: string | null; orgRole: OrgRole | null },
  doc: { ownerId: string; orgId: string },
): boolean {
  if (!u.orgId || u.orgId !== doc.orgId) return false
  if (u.orgRole === 'owner' || u.orgRole === 'admin') return true
  return doc.ownerId === u.id
}
