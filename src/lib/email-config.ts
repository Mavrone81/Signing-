// Server-only module: imports src/lib/crypto (DATA_KEY) and Prisma, so it must
// never be pulled into a client bundle.
//
// Outbound SMTP is configured PER ORGANIZATION with a SHARED fallback:
//  - an org may run its own server (EmailConfig row with that orgId);
//  - otherwise its mail goes through the shared server (the row with no org),
//    under the shared server's From address;
//  - with neither usable, nothing is sent (the mailer returns not_configured).
// Every send names the org it is sending AS (see SendEmailInput.orgId), so the
// type checker rejects a send site that doesn't pick its tenant.
//
// The SMTP password is stored AES-256-GCM encrypted (src/lib/crypto.ts,
// DATA_KEY) and is NEVER returned to the client.
import { prisma } from '@/lib/db'
import { encrypt, decrypt } from '@/lib/crypto'

export const EMAIL_PROVIDER = 'smtp'

// --- Secret encryption (string <-> base64 wire form over the Buffer crypto) ---

export function encryptSecret(plain: string): string {
  return encrypt(Buffer.from(plain, 'utf8')).toString('base64')
}

export function decryptSecret(enc: string): string {
  return decrypt(Buffer.from(enc, 'base64')).toString('utf8')
}

// --- Pure helpers (unit-tested; no DB / no I/O) ---

export type EmailConfigRow = {
  enabled: boolean
  host: string | null
  port: number | null
  secure: boolean
  username: string | null
  passwordEnc: string | null
  fromName: string | null
  fromEmail: string | null
}

// A row is USABLE only when it is enabled AND fully addressable (host, port, and
// a from address). A username/password is optional (some relays accept
// unauthenticated localhost submission), so it is not required here.
export function emailIsConfigured(
  row: Pick<EmailConfigRow, 'enabled' | 'host' | 'port' | 'fromEmail'> | null | undefined,
): boolean {
  return !!row && row.enabled && !!row.host && !!row.port && !!row.fromEmail
}

// Which server a send goes through: 'org' = the org's own, 'shared' = the
// fallback. An org row that is switched off (or incomplete) falls back to the
// shared server rather than silencing the org — turning your own server off
// means "use the shared one".
export type EmailRoute = 'org' | 'shared'

export function pickEmailConfig<R extends Pick<EmailConfigRow, 'enabled' | 'host' | 'port' | 'fromEmail'>>(
  orgRow: R | null | undefined,
  sharedRow: R | null | undefined,
): { row: R; via: EmailRoute } | null {
  if (emailIsConfigured(orgRow)) return { row: orgRow!, via: 'org' }
  if (emailIsConfigured(sharedRow)) return { row: sharedRow!, via: 'shared' }
  return null
}

// --- DB reads (short-TTL cached per org, invalidated on save) ---

const ROW_SELECT = {
  enabled: true,
  host: true,
  port: true,
  secure: true,
  username: true,
  passwordEnc: true,
  fromName: true,
  fromEmail: true,
} as const

const CACHE_TTL_MS = 30_000
const SHARED_KEY = '\u0000shared'
// Keyed by org, and caching the RESOLVED result (including a fallback), so one
// org's settings can never answer for another's.
const cache = new Map<string, { at: number; resolved: { row: EmailConfigRow; via: EmailRoute } | null }>()

async function readSharedRow(): Promise<EmailConfigRow | null> {
  return prisma.emailConfig.findFirst({ where: { orgId: null }, select: ROW_SELECT })
}

async function readOrgRow(orgId: string): Promise<EmailConfigRow | null> {
  return prisma.emailConfig.findUnique({ where: { orgId }, select: ROW_SELECT })
}

async function resolve(orgId: string | null): Promise<{ row: EmailConfigRow; via: EmailRoute } | null> {
  const key = orgId ?? SHARED_KEY
  const now = Date.now()
  const hit = cache.get(key)
  if (hit && now - hit.at < CACHE_TTL_MS) return hit.resolved
  const [orgRow, sharedRow] = await Promise.all([orgId ? readOrgRow(orgId) : null, readSharedRow()])
  const resolved = pickEmailConfig(orgRow, sharedRow)
  cache.set(key, { at: now, resolved })
  return resolved
}

// Call after any write so the change is visible immediately (not after TTL).
// An org's save affects only that org; the shared server's save affects every
// org that falls back to it, so it (and a call with no argument) clears all.
export function invalidateEmailConfigCache(orgId?: string | null): void {
  if (orgId) cache.delete(orgId)
  else cache.clear()
}

// Whether mail sent as this org would go anywhere (own server or shared).
// `null` asks about the shared server alone.
export async function isEmailConfigured(orgId: string | null): Promise<boolean> {
  return (await resolve(orgId)) != null
}

// Decrypted, ready-to-send config for mail sent as `orgId`, or null when neither
// the org's own server nor the shared one is usable. SERVER-ONLY — returns the
// SMTP password; used exclusively by src/lib/mailer.ts.
export type ActiveEmailConfig = {
  host: string
  port: number
  secure: boolean
  username: string | null
  password: string | null
  fromName: string | null
  fromEmail: string
  via: EmailRoute
}

export async function getActiveEmailConfig(orgId: string | null): Promise<ActiveEmailConfig | null> {
  const resolved = await resolve(orgId)
  if (!resolved) return null
  const { row, via } = resolved
  return {
    host: row.host!,
    port: row.port!,
    secure: row.secure,
    username: row.username,
    password: row.passwordEnc ? decryptSecret(row.passwordEnc) : null,
    fromName: row.fromName,
    fromEmail: row.fromEmail!,
    via,
  }
}

// Config for the Settings page — NO secret, only whether a password is stored.
export type EmailConfigClientView = {
  enabled: boolean
  host: string
  port: string
  secure: boolean
  username: string
  hasPassword: boolean
  fromName: string
  fromEmail: string
}

function toClientView(row: EmailConfigRow | null): EmailConfigClientView {
  return {
    enabled: row?.enabled ?? false,
    host: row?.host ?? '',
    port: row?.port != null ? String(row.port) : '',
    secure: row?.secure ?? true,
    username: row?.username ?? '',
    hasPassword: !!row?.passwordEnc,
    fromName: row?.fromName ?? '',
    fromEmail: row?.fromEmail ?? '',
  }
}

// The org's OWN server settings (never the shared server's).
export async function getOrgEmailConfigForClient(orgId: string): Promise<EmailConfigClientView> {
  return toClientView(await readOrgRow(orgId))
}

// The shared server's settings — for platform admins only.
export async function getSharedEmailConfigForClient(): Promise<EmailConfigClientView> {
  return toClientView(await readSharedRow())
}

// Where mail sent as this org goes right now, for the Settings page: through its
// own server, through the shared server (and from which address), or nowhere.
export async function describeEmailRoute(
  orgId: string,
): Promise<{ via: EmailRoute; fromEmail: string } | null> {
  const [orgRow, sharedRow] = await Promise.all([readOrgRow(orgId), readSharedRow()])
  const picked = pickEmailConfig(orgRow, sharedRow)
  return picked ? { via: picked.via, fromEmail: picked.row.fromEmail! } : null
}
