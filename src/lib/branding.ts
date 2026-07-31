// Server-only white-label branding helpers. Imports src/lib/storage (getObject →
// DATA_KEY / env), so it must never be pulled into a client bundle — consumers
// are RSC / server actions / route handlers.
//
// A brand lives on the Organization (one brand per org): brandName, brandColor,
// logoKey (all nullable). An org that has set NONE of them is "uncustomized" and
// every surface falls back to the generic Bevora Sign identity, so existing orgs
// look exactly as before. The pure helpers here (resolveBrand / normalizeHex /
// logoKeyFor / logoMimeFromKey / validateLogo) do no I/O and are unit-tested;
// only loadLogoDataUri touches the encrypted blob store.
import { getObject } from '@/lib/storage'

export const DEFAULT_BRAND_NAME = 'Bevora Sign'
// the Bevora brand gold — the product's --brand-primary. Used whenever an org hasn't
// picked its own colour.
export const DEFAULT_BRAND_COLOR = '#b8860b'

// Logos are small; cap well under the PDF upload limit.
export const MAX_LOGO_BYTES = 1024 * 1024 // ~1MB

// The org-scoped storage key for a logo of the given type. Keyed by orgId (one
// logo per org) with the extension carrying the MIME type (the blob store only
// keeps bytes, so we recover the content-type from the key on read).
export function logoKeyFor(orgId: string, ext: 'png' | 'jpg' | 'svg'): string {
  return `branding/${orgId}/logo.${ext}`
}

export function logoMimeFromKey(key: string): string {
  const ext = key.split('.').pop()?.toLowerCase()
  if (ext === 'png') return 'image/png'
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg'
  if (ext === 'svg') return 'image/svg+xml'
  return 'application/octet-stream'
}

// A normalized `#rrggbb` colour, or null if the input isn't a valid hex colour.
// Accepts `#rgb` / `#rrggbb` (with or without the leading '#'), case-insensitive.
export function normalizeHex(input: string | null | undefined): string | null {
  if (!input) return null
  const s = input.trim().replace(/^#/, '')
  if (/^[0-9a-fA-F]{3}$/.test(s)) {
    return '#' + s.split('').map((c) => c + c).join('').toLowerCase()
  }
  if (/^[0-9a-fA-F]{6}$/.test(s)) return '#' + s.toLowerCase()
  return null
}

export interface OrgBrandInput {
  name: string
  brandName: string | null
  brandColor: string | null
  logoKey: string | null
}

export interface ResolvedBrand {
  // Did the org customize ANY branding? When false, callers show the generic
  // Bevora Sign identity (mark + wordmark + green) exactly as before.
  customized: boolean
  // The display name to show when customized: the org's brandName, or the org's
  // own name when brandName is null.
  name: string
  // A safe `#rrggbb` accent colour: the org's brandColor, or the default green.
  color: string
  hasLogo: boolean
  logoKey: string | null
}

// Resolve an org's raw branding columns into the display shape, applying every
// fallback. `customized` is true when the org set a name, a colour, OR a logo.
export function resolveBrand(org: OrgBrandInput): ResolvedBrand {
  const brandName = org.brandName?.trim() || null
  const color = normalizeHex(org.brandColor)
  const customized = !!(brandName || color || org.logoKey)
  return {
    customized,
    name: brandName || org.name,
    color: color || DEFAULT_BRAND_COLOR,
    hasLogo: !!org.logoKey,
    logoKey: org.logoKey ?? null,
  }
}

// Read + decrypt a logo blob and return it as an inline `data:` URI (so a
// server-rendered page can embed it without a second, separately-authorized
// request — critical for the unauthenticated signer page). Best-effort: returns
// null on any read failure so a missing/corrupt blob degrades to "no logo"
// rather than crashing the page.
export async function loadLogoDataUri(logoKey: string | null): Promise<string | null> {
  if (!logoKey) return null
  try {
    const buf = await getObject(logoKey)
    return `data:${logoMimeFromKey(logoKey)};base64,${buf.toString('base64')}`
  } catch {
    return null
  }
}

export type LogoValidation =
  | { ok: true; ext: 'png' | 'jpg' | 'svg'; mime: string }
  | { ok: false; reason: 'type' | 'size' | 'empty' }

// Authoritative server-side validation of an uploaded logo: enforces the ~1MB
// cap and sniffs the magic bytes (never trusts the declared MIME) so only a real
// PNG / JPEG / SVG is stored. Returns the canonical extension used to key the
// blob and recover the content-type later.
export function validateLogo(buf: Buffer): LogoValidation {
  if (buf.length === 0) return { ok: false, reason: 'empty' }
  if (buf.length > MAX_LOGO_BYTES) return { ok: false, reason: 'size' }

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buf.length >= 8 &&
    buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
    buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a
  ) {
    return { ok: true, ext: 'png', mime: 'image/png' }
  }
  // JPEG: FF D8 FF
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return { ok: true, ext: 'jpg', mime: 'image/jpeg' }
  }
  // SVG: text; look for an <svg root (optionally after an XML prolog / BOM /
  // comments) within the first chunk.
  const head = buf.subarray(0, 1024).toString('utf8').trimStart()
  const stripped = head.replace(/^﻿/, '')
  if (/<svg[\s>]/i.test(stripped) || (/^<\?xml/i.test(stripped) && /<svg[\s>]/i.test(head))) {
    return { ok: true, ext: 'svg', mime: 'image/svg+xml' }
  }
  return { ok: false, reason: 'type' }
}
