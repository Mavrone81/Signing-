import { hash } from '@node-rs/argon2'
import { env } from '../src/env'
import { prisma } from '../src/lib/db'

async function main() {
  if (!env.SEED_ADMIN_PASSWORD) {
    throw new Error('SEED_ADMIN_PASSWORD is required to seed the admin user')
  }

  const passwordHash = await hash(env.SEED_ADMIN_PASSWORD)

  const admin = await prisma.user.upsert({
    where: { email: env.SEED_ADMIN_EMAIL },
    // The seed admin is the deployment's platform ("IT") admin who manages the
    // SSO/OAuth keys — assert isPlatformAdmin on every seed run (idempotent).
    update: { passwordHash, role: 'admin', isPlatformAdmin: true },
    create: {
      email: env.SEED_ADMIN_EMAIL,
      name: 'Admin',
      passwordHash,
      role: 'admin',
      isPlatformAdmin: true,
    },
  })

  // A fresh deploy must seed a usable OWNER: ensure the default Organization
  // exists and the admin owns it. Idempotent — safe to re-run.
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
