-- AlterTable
ALTER TABLE "User" ADD COLUMN     "isPlatformAdmin" BOOLEAN NOT NULL DEFAULT false,
ALTER COLUMN "passwordHash" DROP NOT NULL;

-- CreateTable
CREATE TABLE "AuthProviderConfig" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "clientId" TEXT,
    "clientSecretEnc" TEXT,
    "tenantId" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,

    CONSTRAINT "AuthProviderConfig_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AuthProviderConfig_provider_key" ON "AuthProviderConfig"("provider");

-- Backfill: promote the existing deployment admin to platform admin so the
-- SSO/OAuth Settings page is reachable right after this migration. Matches the
-- default SEED_ADMIN_EMAIL and, as a fallback, the oldest user (the seed admin
-- is always created first). prisma/seed.ts re-asserts this idempotently.
UPDATE "User"
SET "isPlatformAdmin" = true
WHERE "email" = 'admin@bevorasg.com'
   OR "id" = (SELECT "id" FROM "User" ORDER BY "createdAt" ASC LIMIT 1);
