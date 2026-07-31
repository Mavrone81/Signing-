import { rm } from 'node:fs/promises'
import { PrismaClient } from '@prisma/client'

// Cleans up everything global-setup.ts + the spec created, so a local run
// against the shared dev Postgres (`ds-dev-pg`) never leaves e2e leftovers:
// deletes the e2e admin's Documents (Fields + AuditEvents cascade off
// Document via `onDelete: Cascade`), then the e2e admin User row itself, then
// the throwaway STORAGE_DIR this run's encrypted blobs were written under.
export default async function globalTeardown(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL!
  const email = process.env.SEED_ADMIN_EMAIL!

  const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } })
  try {
    const user = await prisma.user.findUnique({ where: { email } })
    if (user) {
      await prisma.document.deleteMany({ where: { ownerId: user.id } })
      await prisma.user.delete({ where: { id: user.id } })
    }
  } finally {
    await prisma.$disconnect()
  }

  if (process.env.STORAGE_DIR) {
    await rm(process.env.STORAGE_DIR, { recursive: true, force: true })
  }
}
