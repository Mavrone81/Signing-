// Database seed — creates the deployment's admin account.
//
// Plain .mjs, and deliberately so. This runs in the PRODUCTION container as
// well as in dev, and the standalone runner image contains no `src/` and no
// dev dependencies. An earlier TypeScript version of this file imported
// `../src/env` and `../src/lib/db` and was invoked through `tsx`; both are
// absent from that image, so `prisma db seed` died with `spawn tsx ENOENT` on
// the first real deploy and left the box with no account to log in as.
//
// Hence: no TypeScript, no path aliases, no `src/` imports, and its own
// PrismaClient rather than the app's singleton. It reads process.env directly
// instead of going through src/env.ts — which is also more correct, since that
// module eagerly validates the app's ENTIRE schema (AUTH_SECRET, DATA_KEY, …)
// and seeding needs none of it.
//
// Idempotent: every write is an upsert, so the per-deploy `prisma db seed`
// re-asserts the admin instead of failing or duplicating.
import { hash } from '@node-rs/argon2'
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

async function main() {
  const email = process.env.SEED_ADMIN_EMAIL
  const password = process.env.SEED_ADMIN_PASSWORD

  // Fail loudly. Seeding a passwordless or misaddressed admin onto a public
  // deployment is far worse than refusing to run.
  if (!email) throw new Error('SEED_ADMIN_EMAIL is required to seed the admin user')
  if (!password) throw new Error('SEED_ADMIN_PASSWORD is required to seed the admin user')

  const passwordHash = await hash(password)

  const admin = await prisma.user.upsert({
    where: { email },
    // The seed admin is the deployment's platform ("IT") admin who manages the
    // SSO/OAuth keys — assert isPlatformAdmin on every seed run.
    update: { passwordHash, role: 'admin', isPlatformAdmin: true },
    create: {
      email,
      name: 'Admin',
      passwordHash,
      role: 'admin',
      isPlatformAdmin: true,
    },
  })

  // A fresh deploy must seed a usable OWNER: without the membership the admin
  // logs in successfully but belongs to no org, which looks like a broken
  // deploy rather than a missing row.
  const org = await prisma.organization.upsert({
    where: { slug: 'default' },
    update: {},
    create: { name: 'Default Organization', slug: 'default' },
  })

  await prisma.membership.upsert({
    where: { orgId_userId: { orgId: org.id, userId: admin.id } },
    update: { role: 'owner' },
    create: { orgId: org.id, userId: admin.id, role: 'owner' },
  })

  console.log(`Seeded admin user: ${admin.email} (owner of ${org.slug})`)
}

main()
  .catch((err) => {
    console.error(err)
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
