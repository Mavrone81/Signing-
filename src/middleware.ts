import NextAuth from 'next-auth'
import { authConfig } from './auth.config'

const { auth } = NextAuth(authConfig)

// Route protection. Public: /login, /api/auth/* (Auth.js handlers), /api/health.
export default auth((req) => {
  const { nextUrl } = req
  // `req.auth` is a truthy session shell even for anonymous requests, so it
  // must NOT be used as the login check on its own — gate on an actual
  // authenticated user (matches the page-level `auth()` guard, which keys off
  // `session.user`). Using `!!req.auth` here made `/login` bounce to `/` for
  // logged-out visitors, producing a redirect loop.
  const isLoggedIn = !!req.auth?.user
  const pathname = nextUrl.pathname
  const isPublic =
    pathname === '/login' ||
    pathname === '/signup' ||
    pathname.startsWith('/api/auth') ||
    pathname === '/api/health' ||
    // Phase 2b — the tokenized recipient signing surface is intentionally
    // UNAUTHENTICATED: the unguessable token in the path IS the authorization
    // (validated per-request in the page/route against a specific Recipient).
    // `/sign/<token>` + its `/api/sign/<token>/…` endpoints only. Note this
    // does NOT match `/signup` (that's `/signup`, not `/sign/…`).
    pathname === '/sign' ||
    pathname.startsWith('/sign/') ||
    pathname.startsWith('/api/sign/') ||
    // An envelope signer's single link (`/e/<token>`): same model — the token
    // is the authorization, and the page only lists that signer's own
    // per-document /sign/<token> links.
    pathname.startsWith('/e/') ||
    // Phase 5 — the PUBLIC REST API is authenticated per-request by a per-org
    // API key (`Authorization: Bearer sk_...`), NOT the user session. So it is
    // "public" to the session middleware; each `/api/v1/**` route enforces the
    // key itself (401 on missing/invalid/revoked) and scopes every action to the
    // key's org. It must NOT be bounced to /login like a session-gated route.
    pathname.startsWith('/api/v1/')

  if (!isLoggedIn && !isPublic) {
    const url = new URL('/login', nextUrl)
    url.searchParams.set('from', pathname)
    return Response.redirect(url)
  }

  if (isLoggedIn && (pathname === '/login' || pathname === '/signup')) {
    // Redirect straight to /documents, not '/'. '/' is itself a server-side
    // redirect() to /documents, and chaining the two produces a React #418
    // hydration error in the console for an authed user hitting /login.
    return Response.redirect(new URL('/documents', nextUrl))
  }
})

export const config = {
  // Run on everything except Next internals, static assets, and the app-icon
  // metadata routes. /api routes ARE covered (unlike the VirtualOffice
  // matcher) because /api/health and /api/auth are the only public API routes
  // here and every other API route must be authenticated too.
  // `icon.svg` (src/app/icon.svg → the favicon) MUST be excluded, or the
  // middleware bounces the browser's favicon request to /login and no icon
  // ever loads. Likewise `pdf.worker.min.mjs` (the pdf.js worker in /public):
  // an UNAUTHENTICATED recipient on /sign/[token] must be able to load it, or
  // the PDF viewer never renders (no canvas, no fields) and signing is broken —
  // a logged-in editor works only because its worker request carries a cookie.
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|icon.svg|apple-icon|pdf.worker.min.mjs).*)',
  ],
}
