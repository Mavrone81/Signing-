import NextAuth from 'next-auth'
import Credentials from 'next-auth/providers/credentials'
import Google from 'next-auth/providers/google'
import MicrosoftEntraID from 'next-auth/providers/microsoft-entra-id'
import { verify } from '@node-rs/argon2'
import { Prisma } from '@prisma/client'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { slugify } from '@/lib/slug'
import { getActiveOAuthConfigs } from '@/lib/auth-providers'
import { authConfig } from './auth.config'

const creds = z.object({ email: z.string().min(1), password: z.string().min(1) })

// Pick an Organization slug not yet taken (mirrors signup's uniqueSlug): the
// slugified base, else `<base>-2`, `<base>-3`, … The DB unique constraint is
// still the source of truth (a P2002 is handled by the caller).
async function uniqueSlug(orgName: string): Promise<string> {
  const base = slugify(orgName)
  const taken = new Set(
    (
      await prisma.organization.findMany({
        where: { OR: [{ slug: base }, { slug: { startsWith: `${base}-` } }] },
        select: { slug: true },
      })
    ).map((o) => o.slug),
  )
  if (!taken.has(base)) return base
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`
    if (!taken.has(candidate)) return candidate
  }
}

// Find-or-create the DB user for an OAuth (Google/Microsoft) sign-in. A brand
// new email gets a personal Organization + owner Membership (mirrors the
// email/password signup flow) so they land in an isolated tenant. An existing
// email signs into their existing org — we never touch their password. OAuth
// users have no passwordHash (nullable column) and can't use Credentials login.
async function provisionOAuthUser(email: string, name: string | null) {
  const existing = await prisma.user.findUnique({ where: { email } })
  if (existing) return existing

  const displayName = name?.trim() || email.split('@')[0]
  const orgName = `${displayName}'s Workspace`
  const slug = await uniqueSlug(orgName)
  try {
    return await prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: { email, name: displayName, role: 'user' },
      })
      const org = await tx.organization.create({ data: { name: orgName, slug } })
      await tx.membership.create({
        data: { orgId: org.id, userId: user.id, role: 'owner' },
      })
      return user
    })
  } catch (err) {
    // Concurrent first sign-in raced us to create the same email/slug — the
    // other transaction won; return the now-existing user instead of 500ing.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      const u = await prisma.user.findUnique({ where: { email } })
      if (u) return u
    }
    throw err
  }
}

// Build the enabled OAuth providers from the DB config (secrets decrypted
// server-side). Failing to read the config must NOT take down email/password
// login, so any error degrades to "no SSO providers".
async function buildOAuthProviders() {
  try {
    const configs = await getActiveOAuthConfigs()
    return configs.map((c) => {
      if (c.provider === 'google') {
        return Google({ clientId: c.clientId, clientSecret: c.clientSecret })
      }
      // microsoft → Auth.js "microsoft-entra-id". The tenant scopes who may sign
      // in ('common' = any Microsoft account; a tenant GUID = that org only).
      const tenant = c.tenantId?.trim() || 'common'
      return MicrosoftEntraID({
        clientId: c.clientId,
        clientSecret: c.clientSecret,
        issuer: `https://login.microsoftonline.com/${tenant}/v2.0`,
      })
    })
  } catch (err) {
    console.error('[auth] failed to build OAuth providers (SSO disabled this request):', err)
    return []
  }
}

// Auth.js v5 async config: the provider list is rebuilt per request from the DB
// (cached ~30s in getActiveOAuthConfigs so it's not a query per request, while
// an IT-admin key change still takes effect within the TTL).
export const { handlers, signIn, signOut, auth } = NextAuth(async () => ({
  ...authConfig,
  callbacks: {
    ...authConfig.callbacks,
    // Node-runtime jwt. Two sign-in shapes:
    //  • OAuth (account.provider !== 'credentials'): provision/find the DB user
    //    by email, then stamp its real id onto token.sub (the provider's own
    //    sub must not become our user id) + role/isPlatformAdmin + org.
    //  • Credentials: authorize() already returned our DB user.
    // On subsequent requests neither `user` nor `account` is present, so the
    // token (org, role, flags) simply persists — no DB hit.
    async jwt({ token, user, account }) {
      if (account && account.provider !== 'credentials' && user) {
        const email = user.email?.toLowerCase().trim()
        if (!email) return token // no email → cannot provision; leave anonymous
        const dbUser = await provisionOAuthUser(email, user.name ?? null)
        token.sub = dbUser.id
        token.role = dbUser.role
        token.name = dbUser.name
        token.isPlatformAdmin = dbUser.isPlatformAdmin
        const membership = await prisma.membership.findFirst({
          where: { userId: dbUser.id },
          orderBy: { createdAt: 'asc' },
        })
        token.orgId = membership?.orgId ?? null
        token.orgRole = membership?.role ?? null
        return token
      }

      if (user) {
        token.role = user.role
        if (user.name) token.name = user.name
        token.isPlatformAdmin = user.isPlatformAdmin ?? false
        const membership = await prisma.membership.findFirst({
          where: { userId: user.id as string },
          orderBy: { createdAt: 'asc' },
        })
        token.orgId = membership?.orgId ?? null
        token.orgRole = membership?.role ?? null
      }
      return token
    },
  },
  providers: [
    Credentials({
      credentials: { email: {}, password: {} },
      authorize: async (raw) => {
        const parsed = creds.safeParse(raw)
        if (!parsed.success) return null

        const { email, password } = parsed.data
        const user = await prisma.user.findUnique({
          where: { email: email.toLowerCase().trim() },
        })
        if (!user) return null
        // OAuth-only users have no local password — reject Credentials login.
        if (!user.passwordHash) return null

        const ok = await verify(user.passwordHash, password)
        if (!ok) return null

        return {
          id: user.id,
          email: user.email,
          name: user.name,
          role: user.role,
          isPlatformAdmin: user.isPlatformAdmin,
        }
      },
    }),
    ...(await buildOAuthProviders()),
  ],
}))
