import type { Metadata } from 'next'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { AuthError } from 'next-auth'
import { signIn } from '@/auth'
import { getEnabledProviders } from '@/lib/auth-providers'
import { BevoraSignMark, BevoraSignWordmark } from '@/components/brand/BevoraSignMark'

export const metadata: Metadata = { title: 'Sign in · Bevora Sign' }

// Trigger the Auth.js OAuth flow for a provider. Over plain HTTP these will
// fail at the provider (redirect-URI rejection) — they light up once HTTPS +
// AUTH_URL are in place; email/password is the working login until then.
async function signInGoogle() {
  'use server'
  await signIn('google', { redirectTo: '/documents' })
}
async function signInMicrosoft() {
  'use server'
  await signIn('microsoft-entra-id', { redirectTo: '/documents' })
}

async function authenticate(formData: FormData) {
  'use server'
  try {
    await signIn('credentials', {
      email: formData.get('email'),
      password: formData.get('password'),
      // Redirect straight to /documents rather than '/' — '/' is itself just
      // a server-side redirect() to /documents (see src/app/page.tsx), and
      // chaining a Server Action redirect straight into another page-level
      // redirect produces "An unexpected response was received from the
      // server" client-side errors (found while getting Task 13's e2e to
      // actually drive a real browser through login). Same final
      // destination, one fewer redirect hop.
      redirectTo: '/documents',
    })
  } catch (error) {
    if (error instanceof AuthError) {
      redirect('/login?error=1')
    }
    throw error // re-throw the redirect
  }
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; registered?: string }>
}) {
  const { error, registered } = await searchParams
  const providers = await getEnabledProviders()
  const anySso = providers.google || providers.microsoft

  return (
    <main className="grid min-h-screen lg:grid-cols-2">
      {/* Brand panel */}
      <div className="relative hidden flex-col justify-between bg-brand-primary-dark p-12 text-white lg:flex">
        <div className="flex items-center gap-2.5">
          <BevoraSignMark size={36} tile="soft" />
          <div className="leading-tight">
            <BevoraSignWordmark className="text-[18px]" onDark />
            <div className="text-[11px] uppercase tracking-[0.18em] text-white/50">
              Self-hosted e-signature
            </div>
          </div>
        </div>
        <div className="max-w-sm">
          <h2 className="text-3xl leading-snug">
            Sign, seal, and <em className="not-italic text-white">certify</em> your
            documents.
          </h2>
          <p className="mt-4 text-[14px] leading-relaxed text-white/70">
            Upload a PDF, place fields, and generate a tamper-evident signed
            document with a full audit trail.
          </p>
        </div>
        <p className="text-[11px] text-white/40">
          &copy; {new Date().getFullYear()} Bevora Sign
        </p>
      </div>

      {/* Sign-in panel */}
      <div className="flex items-center justify-center bg-paper px-6 py-12">
        <div className="w-full max-w-sm">
          {/* Shown on mobile, where the branded panel is hidden. */}
          <div className="mb-8 flex items-center gap-2.5 lg:hidden">
            <BevoraSignMark size={32} />
            <BevoraSignWordmark className="text-[17px] text-ink" />
          </div>
          <div className="mb-8">
            <h1 className="text-[28px] font-semibold text-ink">Sign in</h1>
            <p className="mt-1 text-[14px] text-muted">
              Enter your credentials to access your documents.
            </p>
          </div>

          {registered && (
            <p className="mb-4 rounded-lg bg-good/10 px-3 py-2 text-[13px] text-good">
              Account created. Please sign in.
            </p>
          )}

          {anySso && (
            <div className="mb-6 space-y-2.5">
              {providers.google && (
                <form action={signInGoogle}>
                  <button
                    type="submit"
                    className="flex min-h-11 w-full items-center justify-center gap-2.5 rounded-lg border border-edge-strong bg-paper px-4 text-[14px] font-medium text-ink transition-colors hover:bg-shell"
                  >
                    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
                      <path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.71-1.57 2.68-3.89 2.68-6.62Z" />
                      <path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.02-3.7H.96v2.33A9 9 0 0 0 9 18Z" />
                      <path fill="#FBBC05" d="M3.98 10.72a5.4 5.4 0 0 1 0-3.44V4.95H.96a9 9 0 0 0 0 8.1l3.02-2.33Z" />
                      <path fill="#EA4335" d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.59C13.47.9 11.43 0 9 0A9 9 0 0 0 .96 4.95l3.02 2.33C4.68 5.16 6.66 3.58 9 3.58Z" />
                    </svg>
                    Sign in with Google
                  </button>
                </form>
              )}
              {providers.microsoft && (
                <form action={signInMicrosoft}>
                  <button
                    type="submit"
                    className="flex min-h-11 w-full items-center justify-center gap-2.5 rounded-lg border border-edge-strong bg-paper px-4 text-[14px] font-medium text-ink transition-colors hover:bg-shell"
                  >
                    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
                      <path fill="#F25022" d="M0 0h8.5v8.5H0z" />
                      <path fill="#7FBA00" d="M9.5 0H18v8.5H9.5z" />
                      <path fill="#00A4EF" d="M0 9.5h8.5V18H0z" />
                      <path fill="#FFB900" d="M9.5 9.5H18V18H9.5z" />
                    </svg>
                    Sign in with Microsoft
                  </button>
                </form>
              )}
              <div className="flex items-center gap-3 pt-1.5">
                <span className="h-px flex-1 bg-edge" />
                <span className="text-[12px] uppercase tracking-wide text-muted">or</span>
                <span className="h-px flex-1 bg-edge" />
              </div>
            </div>
          )}

          <form action={authenticate} className="space-y-4">
            <div>
              <label
                htmlFor="email"
                className="mb-1.5 block text-[13px] font-medium text-ink"
              >
                Email
              </label>
              <input
                id="email"
                name="email"
                type="email"
                autoComplete="email"
                placeholder="you@bevorasg.com"
                required
                className="w-full rounded-lg border border-edge-strong bg-paper px-3 py-2 text-[14px] text-ink outline-none focus:border-brand-primary focus:ring-1 focus:ring-brand-primary"
              />
            </div>
            <div>
              <label
                htmlFor="password"
                className="mb-1.5 block text-[13px] font-medium text-ink"
              >
                Password
              </label>
              <input
                id="password"
                name="password"
                type="password"
                autoComplete="current-password"
                placeholder="••••••••"
                required
                className="w-full rounded-lg border border-edge-strong bg-paper px-3 py-2 text-[14px] text-ink outline-none focus:border-brand-primary focus:ring-1 focus:ring-brand-primary"
              />
            </div>

            {error && (
              <p className="rounded-lg bg-danger-tint px-3 py-2 text-[13px] text-danger">
                Invalid email or password.
              </p>
            )}

            <button
              type="submit"
              className="w-full rounded-lg bg-brand-primary px-4 py-2.5 text-[14px] font-medium text-white transition-colors hover:bg-brand-primary-dark"
            >
              Sign in
            </button>
          </form>

          <p className="mt-6 text-center text-[13px] text-muted">
            Don&apos;t have an account?{' '}
            <Link href="/signup" className="font-medium text-brand-primary hover:underline">
              Create an account
            </Link>
          </p>
        </div>
      </div>
    </main>
  )
}
