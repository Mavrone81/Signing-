import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { hash } from '@node-rs/argon2'
import { PrismaClient } from '@prisma/client'

// Runs once, in the main Playwright process, before the webServer starts and
// before any test file executes. Applies pending migrations (idempotent —
// safe to run against an already-migrated dev DB) and upserts the dedicated
// e2e admin user that e2e/sign-flow.spec.ts logs in as. See
// playwright.config.ts for how DATABASE_URL / SEED_ADMIN_* are derived.
export default async function globalSetup(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL!
  const repoRoot = path.resolve(__dirname, '..')

  execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
    cwd: repoRoot,
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: databaseUrl },
  })

  const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } })
  try {
    const email = process.env.SEED_ADMIN_EMAIL!
    const passwordHash = await hash(process.env.SEED_ADMIN_PASSWORD!)
    await prisma.user.upsert({
      where: { email },
      update: { passwordHash, role: 'admin' },
      create: {
        email,
        name: 'E2E Admin',
        passwordHash,
        role: 'admin',
      },
    })
  } finally {
    await prisma.$disconnect()
  }
}
