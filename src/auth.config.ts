import type { NextAuthConfig } from 'next-auth'

// Edge-safe base config (no Prisma / no native modules) — shared by middleware
// and the full server-side auth in auth.ts. The Credentials provider with the
// DB lookup lives in auth.ts (Node runtime only).
export const authConfig = {
  // This app is designed to run behind a reverse proxy (nginx), so the
  // request host comes from the proxy's forwarded headers. Auth.js v5 rejects
  // proxied hosts as `UntrustedHost` in production unless we trust them here —
  // without this, every /api/auth/* call 500s and no one can sign in. The
  // canonical external URL is still supplied per-environment via AUTH_URL.
  trustHost: true,
  pages: { signIn: '/login' },
  session: { strategy: 'jwt' },
  providers: [],
  callbacks: {
    // Edge-safe base callbacks (no DB). The org membership is loaded and
    // written onto the token in auth.ts's jwt callback (Node runtime), which
    // overrides this one; here we only pass through what's already on the
    // token so the edge session shape stays complete for middleware.
    jwt({ token, user }) {
      if (user) {
        token.role = user.role
        if (user.name) token.name = user.name
      }
      return token
    },
    session({ session, token }) {
      if (session.user) {
        session.user.id = token.sub as string
        session.user.role = token.role
        session.user.orgId = token.orgId ?? null
        session.user.orgRole = token.orgRole ?? null
        session.user.isPlatformAdmin = token.isPlatformAdmin ?? false
      }
      return session
    },
  },
} satisfies NextAuthConfig
