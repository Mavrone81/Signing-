// Server-only module: it imports src/lib/crypto (DATA_KEY) and Prisma, so it
// must never be pulled into a client bundle. Consumers are RSC/server actions.
import type { Session } from 'next-auth'
import { prisma } from '@/lib/db'
import { encrypt, decrypt } from '@/lib/crypto'

// Server-only helpers for the deployment-wide OAuth/SSO provider config
// (AuthProviderConfig rows). The client secret is stored AES-256-GCM encrypted
// (src/lib/crypto.ts, DATA_KEY) and NEVER returned to the client.

export const OAUTH_PROVIDERS = ['google', 'microsoft'] as const
export type OAuthProvider = (typeof OAUTH_PROVIDERS)[number]

// Auth.js provider ids used in the callback URL path (/api/auth/callback/<id>).
// 'microsoft' maps to Auth.js's built-in "microsoft-entra-id" provider id.
export const AUTHJS_PROVIDER_ID: Record<OAuthProvider, string> = {
  google: 'google',
  microsoft: 'microsoft-entra-id',
}

// --- Secret encryption (string <-> base64 wire form over the Buffer crypto) ---

export function encryptSecret(plain: string): string {
  return encrypt(Buffer.from(plain, 'utf8')).toString('base64')
}

export function decryptSecret(enc: string): string {
  return decrypt(Buffer.from(enc, 'base64')).toString('utf8')
}

// --- Pure helpers (unit-tested; no DB / no I/O) ---

export type ProviderRow = {
  provider: string
  enabled: boolean
  clientId: string | null
  clientSecretEnc: string | null
  tenantId: string | null
}

// A provider is USABLE only when it is enabled AND fully configured (has both a
// client id and an encrypted secret). Enabled-but-half-configured rows are not
// wired up — this avoids Auth.js throwing on a partial provider.
export function providerIsConfigured(row: Pick<ProviderRow, 'enabled' | 'clientId' | 'clientSecretEnc'>): boolean {
  return row.enabled && !!row.clientId && !!row.clientSecretEnc
}

// Which providers show a "Sign in with …" button / get wired into Auth.js.
export function selectUsableProviders(rows: ProviderRow[]): OAuthProvider[] {
  return rows
    .filter((r) => (OAUTH_PROVIDERS as readonly string[]).includes(r.provider) && providerIsConfigured(r))
    .map((r) => r.provider as OAuthProvider)
}

// Platform-admin ("IT admin") gate. Single source of truth used by the Settings
// page, its save action, and any config read/write that exposes secrets.
export function isPlatformAdmin(session: Session | null | undefined): boolean {
  return session?.user?.isPlatformAdmin === true
}

// --- DB reads ---

// Short-TTL cache so we don't hit the DB on every request when building the
// Auth.js provider list, while a key change still takes effect within ~30s.
const CACHE_TTL_MS = 30_000
let cache: { at: number; rows: ProviderRow[] } | null = null

async function readRows(): Promise<ProviderRow[]> {
  const now = Date.now()
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.rows
  const rows = await prisma.authProviderConfig.findMany({
    select: { provider: true, enabled: true, clientId: true, clientSecretEnc: true, tenantId: true },
  })
  cache = { at: now, rows }
  return rows
}

// Call after any write so the change is visible immediately (not after TTL).
export function invalidateProviderCache(): void {
  cache = null
}

// Decrypted, ready-to-instantiate configs for the enabled+configured providers.
// SERVER-ONLY — returns secrets; used exclusively by src/auth.ts.
export type ActiveOAuthConfig = {
  provider: OAuthProvider
  clientId: string
  clientSecret: string
  tenantId: string | null
}

export async function getActiveOAuthConfigs(): Promise<ActiveOAuthConfig[]> {
  const rows = await readRows()
  const out: ActiveOAuthConfig[] = []
  for (const provider of selectUsableProviders(rows)) {
    const row = rows.find((r) => r.provider === provider)!
    out.push({
      provider,
      clientId: row.clientId!,
      clientSecret: decryptSecret(row.clientSecretEnc!),
      tenantId: row.tenantId,
    })
  }
  return out
}

// Which providers are enabled+configured — NO secrets. For the login page.
export async function getEnabledProviders(): Promise<Record<OAuthProvider, boolean>> {
  const usable = new Set(selectUsableProviders(await readRows()))
  return { google: usable.has('google'), microsoft: usable.has('microsoft') }
}

// Per-provider status for the Settings page — NO secrets, only whether one is
// set. `hasSecret` tells the UI to show "configured" and keep the input empty.
export type ProviderClientView = {
  provider: OAuthProvider
  enabled: boolean
  clientId: string
  hasSecret: boolean
  tenantId: string
}

export async function getProviderConfigsForClient(): Promise<Record<OAuthProvider, ProviderClientView>> {
  const rows = await prisma.authProviderConfig.findMany({
    select: { provider: true, enabled: true, clientId: true, clientSecretEnc: true, tenantId: true },
  })
  const by = new Map(rows.map((r) => [r.provider, r]))
  const view = (provider: OAuthProvider): ProviderClientView => {
    const r = by.get(provider)
    return {
      provider,
      enabled: r?.enabled ?? false,
      clientId: r?.clientId ?? '',
      hasSecret: !!r?.clientSecretEnc,
      tenantId: r?.tenantId ?? '',
    }
  }
  return { google: view('google'), microsoft: view('microsoft') }
}
