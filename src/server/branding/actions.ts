// Server-only core of the white-label branding save. Kept separate from the
// Next form action (src/app/(app)/settings/branding/actions.ts) so the org-admin
// gate + validation + tenant-scoped persistence are directly unit-testable
// without a request/redirect context (mirrors src/server/templates/actions.ts).
import type { OrgRole } from '@prisma/client'
import { prisma } from '@/lib/db'
import { putObject, deleteObject } from '@/lib/storage'
import { normalizeHex, logoKeyFor, validateLogo, MAX_LOGO_BYTES } from '@/lib/branding'

// The acting user's tenancy context — their active org and role in it.
export type BrandingActor = { orgId: string | null; orgRole: OrgRole | null }

export interface SaveBrandingInput {
  brandName: string | null
  brandColor: string | null
  // Raw uploaded logo bytes. undefined = leave the logo unchanged.
  logo?: Buffer | null
  // Clear the stored logo (ignored when a new logo is supplied).
  removeLogo?: boolean
}

export type SaveBrandingResult =
  | { ok: true }
  | { ok: false; error: 'FORBIDDEN' | 'type' | 'size' | 'empty' }

// Only an org OWNER or ADMIN of an actual org may edit branding (self-service,
// per-org — NOT a platform-admin gate). A plain member or no membership is
// denied.
export function canEditBranding(actor: BrandingActor): boolean {
  return !!actor.orgId && (actor.orgRole === 'owner' || actor.orgRole === 'admin')
}

/**
 * Persist an org's branding, scoped to `actor.orgId` (one org can never touch
 * another's row or blob). Re-checks the org-admin gate. Validates + encrypts an
 * uploaded logo (magic-byte sniff + size cap) and cleans up a superseded blob.
 * Returns a result — the caller (form action / route) maps it to UI/redirects.
 */
export async function saveOrgBranding(
  actor: BrandingActor,
  input: SaveBrandingInput,
): Promise<SaveBrandingResult> {
  if (!canEditBranding(actor)) return { ok: false, error: 'FORBIDDEN' }
  const orgId = actor.orgId as string

  const data: { brandName: string | null; brandColor: string | null; logoKey?: string | null } = {
    brandName: input.brandName && input.brandName.trim() ? input.brandName.trim().slice(0, 120) : null,
    // Invalid hex clears the colour (→ falls back to the default green).
    brandColor: normalizeHex(input.brandColor),
  }

  // Fetch the existing logoKey to clean up a superseded blob (type change/remove).
  const current = await prisma.organization.findUnique({
    where: { id: orgId },
    select: { logoKey: true },
  })
  const oldKey = current?.logoKey ?? null

  if (input.logo && input.logo.length > 0) {
    if (input.logo.length > MAX_LOGO_BYTES) return { ok: false, error: 'size' }
    const v = validateLogo(input.logo)
    if (!v.ok) return { ok: false, error: v.reason }
    const key = logoKeyFor(orgId, v.ext)
    // Store the encrypted blob BEFORE the DB write, so a failure never leaves
    // the row pointing at content that was never written.
    await putObject(key, input.logo)
    data.logoKey = key
    if (oldKey && oldKey !== key) await deleteObject(oldKey)
  } else if (input.removeLogo) {
    data.logoKey = null
    if (oldKey) await deleteObject(oldKey)
  }

  await prisma.organization.update({ where: { id: orgId }, data })
  return { ok: true }
}
