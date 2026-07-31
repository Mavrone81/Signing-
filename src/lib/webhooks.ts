import { createHmac, randomBytes } from 'crypto'
import { prisma } from '@/lib/db'

// The signing events a webhook may subscribe to. `*` (handled in the filter)
// subscribes to every event.
export const WEBHOOK_EVENTS = [
  'document.sent',
  'recipient.viewed',
  'recipient.signed',
  'document.completed',
  'document.declined',
] as const

export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number]

export function isWebhookEvent(v: unknown): v is WebhookEvent {
  return typeof v === 'string' && (WEBHOOK_EVENTS as readonly string[]).includes(v)
}

// A webhook signing secret: `whsec_<random>`. Generated at endpoint creation and
// shown to the org admin so they can verify the HMAC on their receiver.
export function generateWebhookSecret(): string {
  return `whsec_${randomBytes(24).toString('base64url')}`
}

// HMAC-SHA256 of the raw request body under the endpoint secret, hex-encoded.
// Receivers recompute this over the exact bytes they received and compare to the
// `X-BevoraSign-Signature: sha256=<hex>` header to prove the payload is authentic
// and unmodified.
export function signBody(secret: string, body: string): string {
  return createHmac('sha256', secret).update(body, 'utf8').digest('hex')
}

// Basic SSRF guard. Webhook URLs are org-controlled, so a malicious/careless org
// admin could aim one at an internal service; reject obviously-internal targets
// (localhost, link-local, private RFC-1918 ranges, cloud metadata, non-http
// schemes). This is a best-effort allow-http(s)-to-public heuristic — hostnames
// that resolve to internal IPs at request time are NOT caught here (no DNS
// resolution), which is noted in the delivery contract.
export function isBlockedWebhookUrl(rawUrl: string): boolean {
  let u: URL
  try {
    u = new URL(rawUrl)
  } catch {
    return true
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return true
  const host = u.hostname.toLowerCase()

  if (
    host === 'localhost' ||
    host === '0.0.0.0' ||
    host === '::1' ||
    host === '[::1]' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal')
  ) {
    return true
  }

  // IPv4 literal → check against loopback / private / link-local / metadata.
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])]
    if (a === 127) return true // loopback
    if (a === 10) return true // private
    if (a === 0) return true
    if (a === 169 && b === 254) return true // link-local + cloud metadata (169.254.169.254)
    if (a === 172 && b >= 16 && b <= 31) return true // private
    if (a === 192 && b === 168) return true // private
  }
  return false
}

export interface WebhookPayload {
  event: WebhookEvent
  data: unknown
  timestamp: string
}

const DELIVERY_TIMEOUT_MS = 5000
const MAX_ATTEMPTS = 2 // one initial try + one retry

// POST the signed body to one endpoint, with a short timeout and a single
// retry. Never throws; returns whether a 2xx was received (for logging only).
async function deliverOne(
  endpoint: { id: string; url: string; secret: string },
  body: string,
  event: WebhookEvent,
): Promise<boolean> {
  if (isBlockedWebhookUrl(endpoint.url)) {
    console.error('[webhooks] blocked internal/invalid url for endpoint', endpoint.id)
    return false
  }
  const signature = `sha256=${signBody(endpoint.secret, body)}`

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), DELIVERY_TIMEOUT_MS)
    try {
      const res = await fetch(endpoint.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-bevorasign-signature': signature,
          'x-bevorasign-event': event,
        },
        body,
        signal: controller.signal,
        // Do not follow redirects: a 3xx to an internal target would bypass the
        // SSRF guard above.
        redirect: 'manual',
      })
      clearTimeout(timer)
      if (res.ok) return true
      console.error(`[webhooks] endpoint ${endpoint.id} responded ${res.status} (attempt ${attempt})`)
    } catch (err) {
      clearTimeout(timer)
      console.error(
        `[webhooks] delivery to ${endpoint.id} failed (attempt ${attempt}):`,
        err instanceof Error ? err.message : String(err),
      )
    }
  }
  return false
}

/**
 * Dispatches `event` to every ENABLED webhook of `orgId` subscribed to it (or to
 * `*`). Builds ONE canonical JSON body `{event, data, timestamp}` and signs it
 * per-endpoint with that endpoint's secret. BEST-EFFORT: fully wrapped so a DB or
 * network failure can NEVER throw into the signing/send flow that called it
 * (same contract as email `notify`). Deliveries run concurrently.
 */
export async function dispatchEvent(orgId: string, event: WebhookEvent, data: unknown): Promise<void> {
  try {
    const endpoints = await prisma.webhook.findMany({
      where: { orgId, enabled: true },
      select: { id: true, url: true, secret: true, events: true },
    })
    const subscribed = endpoints.filter((e) => e.events.includes(event) || e.events.includes('*'))
    if (subscribed.length === 0) return

    const payload: WebhookPayload = { event, data, timestamp: new Date().toISOString() }
    const body = JSON.stringify(payload)

    await Promise.all(subscribed.map((e) => deliverOne(e, body, event)))
  } catch (err) {
    console.error('[webhooks] dispatch failed:', err instanceof Error ? err.message : String(err))
  }
}
