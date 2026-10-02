import { auth } from '@/auth'
import { env } from '@/env'
// Generated at BUILD TIME (scripts/generate-git-sha.mjs), never read from a
// runtime env var here — a runtime env var would be circular for the HTTP
// test that spawns its own server: it could set the var and then assert its
// own value back, proving nothing about what was actually built. This file
// is gitignored and does not exist until a build or dev server has run.
import { GIT_SHA } from '@/generated/git-sha'

export const dynamic = 'force-dynamic'

// Public, unauthenticated response stays EXACTLY { status: 'ok' } for
// uptime monitors — unchanged. The deployed commit is added ONLY for an
// authenticated caller: this repo is public, so an unauthenticated sha
// endpoint would let anyone permanently check whether a merged fix has
// actually been deployed yet — the exact publish-to-deploy window this
// project works to minimize, made observable forever for convenience.
// "Authenticated" is either a real user session OR the same shared secret
// the reconciliation route already uses (X-Cron-Secret) — no second secret
// introduced for this.
export async function GET(req: Request) {
  const session = await auth()
  const providedSecret = req.headers.get('x-cron-secret')
  const authenticated = !!session?.user || (!!env.CRON_SECRET && providedSecret === env.CRON_SECRET)
  if (!authenticated) return Response.json({ status: 'ok' })
  return Response.json({ status: 'ok', sha: GIT_SHA })
}
