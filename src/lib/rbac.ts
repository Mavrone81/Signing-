import type { OrgRole } from '@prisma/client'

type DocActor = { id: string; orgId: string | null; orgRole: OrgRole | null }

// Owner-only document access (PDPA). A document is reachable ONLY by the user
// who uploaded it, and only inside the document's own organization. Org owners
// and admins get NO extra document access: the org match is a tenancy guard, not
// a grant. There is deliberately no admin override — if an uploader's account is
// removed, their documents are unreachable in-app and recovery is database work.
//
// Every page, route and action that touches a single document goes through this
// function; listings go through `documentScope` below. Keep the rule here only.
//
// A user with no membership (orgId === null) can never match a document's org,
// so they are denied everywhere — a null org degrades to "no document access",
// never a crash.
export function canAccessDocument(
  u: DocActor,
  doc: { ownerId: string; orgId: string },
): boolean {
  if (!u.orgId || u.orgId !== doc.orgId) return false
  return doc.ownerId === u.id
}

// The Prisma `where` for "documents this user may see", matching
// canAccessDocument. Null means the user has no org and must be shown nothing —
// callers skip the query rather than run it unscoped.
export function documentScope(u: DocActor): { orgId: string; ownerId: string } | null {
  if (!u.orgId) return null
  return { orgId: u.orgId, ownerId: u.id }
}
