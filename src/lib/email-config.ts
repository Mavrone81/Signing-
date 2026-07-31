// Server-only module: imports src/lib/crypto (DATA_KEY) and Prisma, so it must
// never be pulled into a client bundle. Mirrors src/lib/auth-providers.ts, but
// for the deployment-wide SMTP config (EmailConfig singleton, provider 'smtp').
// The SMTP password is stored AES-256-GCM encrypted (src/lib/crypto.ts,
// DATA_KEY) and is NEVER returned to the client.
import { prisma } from '@/lib/db'
import { encrypt, decrypt } from '@/lib/crypto'

// The EmailConfig row is a singleton keyed by this provider value.
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

// SMTP is USABLE only when it is enabled AND fully addressable (host, port, and
// a from address). A username/password is optional (some relays accept
// unauthenticated localhost submission), so it is not required here.
export function emailIsConfigured(
  row: Pick<EmailConfigRow, 'enabled' | 'host' | 'port' | 'fromEmail'> | null | undefined,
): boolean {
  return !!row && row.enabled && !!row.host && !!row.port && !!row.fromEmail
}

// --- DB reads (short-TTL cached, invalidated on save — same as auth-providers) ---

const CACHE_TTL_MS = 30_000
let cache: { at: number; row: EmailConfigRow | null } | null = null

async function readRow(): Promise<EmailConfigRow | null> {
  const now = Date.now()
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.row
  const row = await prisma.emailConfig.findUnique({
    where: { provider: EMAIL_PROVIDER },
    select: {
      enabled: true,
      host: true,
      port: true,
      secure: true,
      username: true,
      passwordEnc: true,
      fromName: true,
      fromEmail: true,
    },
  })
  cache = { at: now, row }
  return row
}

// Call after any write so the change is visible immediately (not after TTL).
export function invalidateEmailConfigCache(): void {
  cache = null
}

// Whether outbound email is enabled + fully configured. Reads through the cache.
export async function isEmailConfigured(): Promise<boolean> {
  return emailIsConfigured(await readRow())
}

// Decrypted, ready-to-send config for an enabled+configured deployment, or null.
// SERVER-ONLY — returns the SMTP password; used exclusively by src/lib/mailer.ts.
export type ActiveEmailConfig = {
  host: string
  port: number
  secure: boolean
  username: string | null
  password: string | null
  fromName: string | null
  fromEmail: string
}

export async function getActiveEmailConfig(): Promise<ActiveEmailConfig | null> {
  const row = await readRow()
  if (!emailIsConfigured(row)) return null
  return {
    host: row!.host!,
    port: row!.port!,
    secure: row!.secure,
    username: row!.username,
    password: row!.passwordEnc ? decryptSecret(row!.passwordEnc) : null,
    fromName: row!.fromName,
    fromEmail: row!.fromEmail!,
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

export async function getEmailConfigForClient(): Promise<EmailConfigClientView> {
  const row = await prisma.emailConfig.findUnique({ where: { provider: EMAIL_PROVIDER } })
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
