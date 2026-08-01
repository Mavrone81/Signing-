// @vitest-environment node
//
// The seed must run in PRODUCTION, not just in dev. That is the whole point of
// this suite, and it is a real defect this repo shipped with: the standalone
// runner image contains no `src/` and no `tsx`, so a seed written as TypeScript
// importing `../src/env` and `../src/lib/db` could never execute there —
// `prisma db seed` failed with `spawn tsx ENOENT` on the first real deploy and
// left the deployment with no account to log in as.
//
// So these tests spawn the seed the way the container does: a bare `node`
// subprocess, given only DATABASE_URL and the SEED_ADMIN_* vars, with no
// loader, no alias resolution and no dev dependencies. A seed that needs any of
// those fails here.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
process.env.DATA_KEY ||= '0'.repeat(64)

import { execFile } from 'node:child_process'
import path from 'node:path'
import { promisify } from 'node:util'
import { verify } from '@node-rs/argon2'
import { prisma } from '../../src/lib/db'

const execFileAsync = promisify(execFile)

const REPO_ROOT = path.resolve(__dirname, '../..')
const SEED_ENTRYPOINT = path.join(REPO_ROOT, 'prisma/seed.mjs')

const EMAIL = 'seed-suite-admin@example.com'
const PASSWORD = 'seed-suite-password-123'

/** Run the seed exactly as production does: plain `node`, nothing else. */
function runSeed(env: Record<string, string> = {}) {
  return execFileAsync(process.execPath, [SEED_ENTRYPOINT], {
    cwd: REPO_ROOT,
    // Deliberately NOT `...process.env` — the point is to prove the seed needs
    // nothing beyond these. NODE_ENV is present only because Next's ambient
    // ProcessEnv type requires it; the seed itself never reads it.
    env: {
      NODE_ENV: process.env.NODE_ENV ?? 'test',
      PATH: process.env.PATH ?? '',
      DATABASE_URL: process.env.DATABASE_URL ?? '',
      SEED_ADMIN_EMAIL: EMAIL,
      SEED_ADMIN_PASSWORD: PASSWORD,
      ...env,
    },
  })
}

async function cleanup() {
  const user = await prisma.user.findUnique({ where: { email: EMAIL } })
  if (user) {
    await prisma.membership.deleteMany({ where: { userId: user.id } })
    await prisma.user.delete({ where: { id: user.id } })
  }
}

beforeAll(cleanup)
afterAll(async () => {
  await cleanup()
  await prisma.$disconnect()
})

describe('production seed', () => {
  it('creates a platform-admin owner of the default org, runnable by bare node', async () => {
    await runSeed()

    const user = await prisma.user.findUnique({
      where: { email: EMAIL },
      include: { memberships: { include: { org: true } } },
    })

    expect(user).not.toBeNull()
    expect(user!.isPlatformAdmin).toBe(true)
    expect(user!.role).toBe('admin')
    // Without an owner membership the admin can log in but sees no org, which
    // is indistinguishable from a broken deploy.
    expect(user!.memberships).toHaveLength(1)
    expect(user!.memberships[0].role).toBe('owner')
    expect(user!.memberships[0].org.slug).toBe('default')
  })

  it('stores the password as a verifiable hash, never plaintext', async () => {
    await runSeed()

    const user = await prisma.user.findUnique({ where: { email: EMAIL } })
    expect(user!.passwordHash).not.toBe(PASSWORD)
    await expect(verify(user!.passwordHash!, PASSWORD)).resolves.toBe(true)
  })

  it('is idempotent — a redeploy re-running it must not fail or duplicate', async () => {
    await runSeed()
    await runSeed()

    const users = await prisma.user.findMany({ where: { email: EMAIL } })
    expect(users).toHaveLength(1)
    const memberships = await prisma.membership.findMany({
      where: { userId: users[0].id },
    })
    expect(memberships).toHaveLength(1)
  })

  it('fails loudly when SEED_ADMIN_PASSWORD is missing', async () => {
    // Silently seeding a passwordless admin on a public deployment would be
    // far worse than refusing to start.
    await expect(runSeed({ SEED_ADMIN_PASSWORD: '' })).rejects.toThrow(
      /SEED_ADMIN_PASSWORD/,
    )
  })
})
