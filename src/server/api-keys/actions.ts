// Server-only core of API-key management (Settings → API keys). Kept separate
// from the Next form actions so the org-admin gate + tenant-scoped persistence
// are directly unit-testable (mirrors src/server/branding/actions.ts). Only an
// org OWNER or ADMIN may create/list/revoke keys, and every operation is scoped
// to `actor.orgId` — one org can never touch another's keys.
import type { OrgRole } from '@prisma/client'
import { prisma } from '@/lib/db'
import { generateApiKey } from '@/lib/api-keys'

export type ApiKeyActor = { orgId: string | null; orgRole: OrgRole | null; userId: string }

export function canManageApiKeys(actor: { orgId: string | null; orgRole: OrgRole | null }): boolean {
  return !!actor.orgId && (actor.orgRole === 'owner' || actor.orgRole === 'admin')
}

export interface ApiKeySummary {
  id: string
  name: string
  prefix: string
  createdAt: Date
  lastUsedAt: Date | null
  revokedAt: Date | null
}

export type CreateApiKeyResult =
  | { ok: true; raw: string; key: ApiKeySummary }
  | { ok: false; error: 'FORBIDDEN' | 'INVALID_NAME' }

/**
 * Mints a new API key for the actor's org. The raw key is returned ONCE here and
 * never persisted — only its prefix + SHA-256 hash are stored. `createdById` is
 * reused as the synthetic actor for API-driven actions, so it must be a real
 * member of the org (the acting user).
 */
export async function createApiKey(actor: ApiKeyActor, nameRaw: string): Promise<CreateApiKeyResult> {
  if (!canManageApiKeys(actor)) return { ok: false, error: 'FORBIDDEN' }
  const name = typeof nameRaw === 'string' ? nameRaw.trim().slice(0, 120) : ''
  if (!name) return { ok: false, error: 'INVALID_NAME' }

  const { raw, prefix, hashedKey } = generateApiKey()
  const key = await prisma.apiKey.create({
    data: {
      orgId: actor.orgId as string,
      name,
      prefix,
      hashedKey,
      createdById: actor.userId,
    },
    select: { id: true, name: true, prefix: true, createdAt: true, lastUsedAt: true, revokedAt: true },
  })
  return { ok: true, raw, key }
}

// List the org's keys (active + revoked), newest first. Never returns the hash.
export async function listApiKeys(orgId: string): Promise<ApiKeySummary[]> {
  return prisma.apiKey.findMany({
    where: { orgId },
    orderBy: { createdAt: 'desc' },
    select: { id: true, name: true, prefix: true, createdAt: true, lastUsedAt: true, revokedAt: true },
  })
}

export type RevokeApiKeyResult = { ok: true } | { ok: false; error: 'FORBIDDEN' | 'NOT_FOUND' }

/**
 * Revokes a key by stamping `revokedAt` — scoped to the actor's org, so revoking
 * another org's key id is a NOT_FOUND (never a cross-tenant write). Idempotent:
 * re-revoking an already-revoked key is a no-op success.
 */
export async function revokeApiKey(actor: ApiKeyActor, keyId: string): Promise<RevokeApiKeyResult> {
  if (!canManageApiKeys(actor)) return { ok: false, error: 'FORBIDDEN' }
  const res = await prisma.apiKey.updateMany({
    where: { id: keyId, orgId: actor.orgId as string, revokedAt: null },
    data: { revokedAt: new Date() },
  })
  if (res.count === 0) {
    // Either no such key in this org, or it was already revoked. Distinguish so
    // an already-revoked key still reads as success (idempotent).
    const exists = await prisma.apiKey.findFirst({
      where: { id: keyId, orgId: actor.orgId as string },
      select: { id: true },
    })
    if (!exists) return { ok: false, error: 'NOT_FOUND' }
  }
  return { ok: true }
}
