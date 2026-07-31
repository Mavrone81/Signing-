import type { Metadata } from 'next'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { AuthError } from 'next-auth'
import { hash } from '@node-rs/argon2'
import { Prisma } from '@prisma/client'
import { z } from 'zod'
import { signIn } from '@/auth'
import { prisma } from '@/lib/db'
import { slugify } from '@/lib/slug'
import { BevoraSignMark, BevoraSignWordmark } from '@/components/brand/BevoraSignMark'

export const metadata: Metadata = { title: 'Create account · Bevora Sign' }

const signupSchema = z.object({
  name: z.string().trim().min(1).max(120),
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(8).max(200),
  orgName: z.string().trim().min(1).max(120),
})

// Picks a slug not yet used by any Organization: the slugified base, else
// `<base>-2`, `<base>-3`, … The DB unique constraint is still the source of
// truth (a P2002 in the transaction is handled), this just avoids the common case.
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

async function register(formData: FormData) {
  'use server'
  const parsed = signupSchema.safeParse({
    name: formData.get('name'),
    email: formData.get('email'),
    password: formData.get('password'),
    orgName: formData.get('orgName'),
  })
  if (!parsed.success) redirect('/signup?error=invalid')
  const { name, email, password, orgName } = parsed.data

  // Fail early (and clearly) on a duplicate email before hashing.
  const existing = await prisma.user.findUnique({ where: { email } })
  if (existing) redirect('/signup?error=email')

  const passwordHash = await hash(password)
  const slug = await uniqueSlug(orgName)

  // User + Organization + owner Membership must all commit together: a partial
  // create would leave an account with no org (or an org with no owner).
  try {
    await prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: { email, name, passwordHash, role: 'user' },
      })
      const org = await tx.organization.create({ data: { name: orgName, slug } })
      await tx.membership.create({
        data: { orgId: org.id, userId: user.id, role: 'owner' },
      })
    })
  } catch (err) {
    // Unique-constraint race (email or slug) → surface as a friendly error
    // rather than a 500.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      redirect('/signup?error=email')
    }
    throw err
  }

  // Sign the new owner straight in (their org is already on the fresh JWT).
  try {
    await signIn('credentials', { email, password, redirectTo: '/documents' })
  } catch (error) {
    if (error instanceof AuthError) {
      // Account exists now, but auto-login failed — send them to log in manually.
      redirect('/login?registered=1')
    }
    throw error // re-throw the signIn redirect
  }
}

const ERRORS: Record<string, string> = {
  email: 'That email is already registered. Try signing in instead.',
  invalid: 'Please check the form and try again (password must be at least 8 characters).',
}

export default async function SignupPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>
}) {
  const { error } = await searchParams
  const errorMessage = error ? (ERRORS[error] ?? ERRORS.invalid) : null

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
            Create your <em className="not-italic text-white">organization</em> and start
            signing.
          </h2>
          <p className="mt-4 text-[14px] leading-relaxed text-white/70">
            Your account owns a workspace. Upload PDFs, place fields, and produce
            tamper-evident signed documents with a full audit trail.
          </p>
        </div>
        <p className="text-[11px] text-white/40">
          &copy; {new Date().getFullYear()} Bevora Sign
        </p>
      </div>

      {/* Sign-up panel */}
      <div className="flex items-center justify-center bg-paper px-6 py-12">
        <div className="w-full max-w-sm">
          {/* Shown on mobile, where the branded panel is hidden. */}
          <div className="mb-8 flex items-center gap-2.5 lg:hidden">
            <BevoraSignMark size={32} />
            <BevoraSignWordmark className="text-[17px] text-ink" />
          </div>
          <div className="mb-8">
            <h1 className="text-[28px] font-semibold text-ink">Create an account</h1>
            <p className="mt-1 text-[14px] text-muted">
              Set up your workspace — you&apos;ll be its owner.
            </p>
          </div>

          <form action={register} className="space-y-4">
            <div>
              <label htmlFor="name" className="mb-1.5 block text-[13px] font-medium text-ink">
                Your name
              </label>
              <input
                id="name"
                name="name"
                type="text"
                autoComplete="name"
                placeholder="Jane Doe"
                required
                className="w-full rounded-lg border border-edge-strong bg-paper px-3 py-2 text-[14px] text-ink outline-none focus:border-brand-primary focus:ring-1 focus:ring-brand-primary"
              />
            </div>
            <div>
              <label htmlFor="email" className="mb-1.5 block text-[13px] font-medium text-ink">
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
              <label htmlFor="orgName" className="mb-1.5 block text-[13px] font-medium text-ink">
                Organization name
              </label>
              <input
                id="orgName"
                name="orgName"
                type="text"
                autoComplete="organization"
                placeholder="Acme Pte Ltd"
                required
                className="w-full rounded-lg border border-edge-strong bg-paper px-3 py-2 text-[14px] text-ink outline-none focus:border-brand-primary focus:ring-1 focus:ring-brand-primary"
              />
            </div>
            <div>
              <label htmlFor="password" className="mb-1.5 block text-[13px] font-medium text-ink">
                Password
              </label>
              <input
                id="password"
                name="password"
                type="password"
                autoComplete="new-password"
                placeholder="At least 8 characters"
                required
                minLength={8}
                className="w-full rounded-lg border border-edge-strong bg-paper px-3 py-2 text-[14px] text-ink outline-none focus:border-brand-primary focus:ring-1 focus:ring-brand-primary"
              />
            </div>

            {errorMessage && (
              <p className="rounded-lg bg-danger-tint px-3 py-2 text-[13px] text-danger">
                {errorMessage}
              </p>
            )}

            <button
              type="submit"
              className="w-full rounded-lg bg-brand-primary px-4 py-2.5 text-[14px] font-medium text-white transition-colors hover:bg-brand-primary-dark"
            >
              Create account
            </button>
          </form>

          <p className="mt-6 text-center text-[13px] text-muted">
            Already have an account?{' '}
            <Link href="/login" className="font-medium text-brand-primary hover:underline">
              Sign in
            </Link>
          </p>
        </div>
      </div>
    </main>
  )
}
