import type { OrgRole } from '@prisma/client'

// Who may manage an ORGANIZATION's own settings (signing certificate, email):
// that org's owners and admins, plus platform admins acting within their own
// org so the deployment's administrator keeps access. A user with no org can
// never manage one.
//
// A per-org setting has THREE surfaces and all of them must use this one
// predicate: the settings PAGE (notFound() when false), its SERVER ACTIONS
// (re-check, never trust the page; take the org from the session, never from
// the form) and the NAV LINK in src/app/(app)/layout.tsx (shown only when true).
export function canManageOrgSettings(
  user: { orgId?: string | null; orgRole?: OrgRole | null; isPlatformAdmin?: boolean } | null | undefined,
): user is { orgId: string; orgRole: OrgRole | null; isPlatformAdmin?: boolean } {
  if (!user?.orgId) return false
  return user.orgRole === 'owner' || user.orgRole === 'admin' || user.isPlatformAdmin === true
}
