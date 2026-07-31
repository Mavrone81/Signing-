// Server-only core of webhook-endpoint management (Settings → Webhooks). Only an
// org OWNER or ADMIN may add/edit/remove endpoints, and every operation is scoped
// to `actor.orgId` — one org can never touch another's webhooks. Mirrors
// src/server/branding/actions.ts / api-keys/actions.ts.
import type { OrgRole } from '@prisma/client'
import { prisma } from '@/lib/db'
import {
  generateWebhookSecret,
  isBlockedWebhookUrl,
  isWebhookEvent,
  WEBHOOK_EVENTS,
  type WebhookEvent,
} from '@/lib/webhooks'

export type WebhookActor = { orgId: string | null; orgRole: OrgRole | null; userId: string }

export function canManageWebhooks(actor: { orgId: string | null; orgRole: OrgRole | null }): boolean {
  return !!actor.orgId && (actor.orgRole === 'owner' || actor.orgRole === 'admin')
}

export interface WebhookSummary {
  id: string
  url: string
  secret: string
  events: string[]
  enabled: boolean
  createdAt: Date
}

type ActionError = 'FORBIDDEN' | 'INVALID_URL' | 'INVALID_EVENTS' | 'NOT_FOUND'

// Normalize a requested event list: keep only known events, dedupe, require ≥1.
function normalizeEvents(raw: unknown): WebhookEvent[] | null {
  if (!Array.isArray(raw)) return null
  const set = new Set<WebhookEvent>()
  for (const e of raw) if (isWebhookEvent(e)) set.add(e)
  return set.size > 0 ? [...set] : null
}

export type CreateWebhookResult = { ok: true; webhook: WebhookSummary } | { ok: false; error: ActionError }

/**
 * Create a webhook endpoint for the actor's org. Validates the URL against the
 * SSRF guard (rejects obviously-internal targets) and the event list, then
 * generates an HMAC signing secret. The secret is returned so the UI can show it.
 */
export async function createWebhook(
  actor: WebhookActor,
  urlRaw: string,
  eventsRaw: unknown,
): Promise<CreateWebhookResult> {
  if (!canManageWebhooks(actor)) return { ok: false, error: 'FORBIDDEN' }
  const url = typeof urlRaw === 'string' ? urlRaw.trim() : ''
  if (!url || isBlockedWebhookUrl(url)) return { ok: false, error: 'INVALID_URL' }
  const events = normalizeEvents(eventsRaw)
  if (!events) return { ok: false, error: 'INVALID_EVENTS' }

  const webhook = await prisma.webhook.create({
    data: {
      orgId: actor.orgId as string,
      url,
      secret: generateWebhookSecret(),
      events,
      createdById: actor.userId,
    },
    select: { id: true, url: true, secret: true, events: true, enabled: true, createdAt: true },
  })
  return { ok: true, webhook }
}

export async function listWebhooks(orgId: string): Promise<WebhookSummary[]> {
  return prisma.webhook.findMany({
    where: { orgId },
    orderBy: { createdAt: 'desc' },
    select: { id: true, url: true, secret: true, events: true, enabled: true, createdAt: true },
  })
}

export type UpdateWebhookResult = { ok: true } | { ok: false; error: ActionError }

/**
 * Edit an endpoint (url / events / enabled), scoped to the actor's org so a
 * foreign id is NOT_FOUND. Only supplied fields change.
 */
export async function updateWebhook(
  actor: WebhookActor,
  id: string,
  patch: { url?: string; events?: unknown; enabled?: boolean },
): Promise<UpdateWebhookResult> {
  if (!canManageWebhooks(actor)) return { ok: false, error: 'FORBIDDEN' }
  const existing = await prisma.webhook.findFirst({
    where: { id, orgId: actor.orgId as string },
    select: { id: true },
  })
  if (!existing) return { ok: false, error: 'NOT_FOUND' }

  const data: { url?: string; events?: WebhookEvent[]; enabled?: boolean } = {}
  if (patch.url !== undefined) {
    const url = typeof patch.url === 'string' ? patch.url.trim() : ''
    if (!url || isBlockedWebhookUrl(url)) return { ok: false, error: 'INVALID_URL' }
    data.url = url
  }
  if (patch.events !== undefined) {
    const events = normalizeEvents(patch.events)
    if (!events) return { ok: false, error: 'INVALID_EVENTS' }
    data.events = events
  }
  if (patch.enabled !== undefined) data.enabled = !!patch.enabled

  await prisma.webhook.update({ where: { id }, data })
  return { ok: true }
}

export type DeleteWebhookResult = { ok: true } | { ok: false; error: ActionError }

export async function deleteWebhook(actor: WebhookActor, id: string): Promise<DeleteWebhookResult> {
  if (!canManageWebhooks(actor)) return { ok: false, error: 'FORBIDDEN' }
  const res = await prisma.webhook.deleteMany({ where: { id, orgId: actor.orgId as string } })
  if (res.count === 0) return { ok: false, error: 'NOT_FOUND' }
  return { ok: true }
}

// Re-export the event catalog for the settings UI.
export { WEBHOOK_EVENTS }
