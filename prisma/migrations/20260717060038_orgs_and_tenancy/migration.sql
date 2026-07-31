-- Multi-tenancy: Organization / Membership / Invitation + Document.orgId.
--
-- Hand-edited from the Prisma-generated draft so it applies cleanly over an
-- existing (non-empty) database: Document.orgId is added NULLABLE, every
-- pre-existing row is backfilled into a single "Default Organization" (with an
-- owner Membership minted for every existing User), and only THEN is the
-- NOT NULL constraint + FK enforced. On a fresh/empty DB the backfill simply
-- affects zero rows and the constraints still apply.

-- CreateEnum
CREATE TYPE "OrgRole" AS ENUM ('owner', 'admin', 'member');

-- CreateTable
CREATE TABLE "Organization" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Organization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Membership" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" "OrgRole" NOT NULL DEFAULT 'member',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Membership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Invitation" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "role" "OrgRole" NOT NULL DEFAULT 'member',
    "token" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "acceptedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Invitation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Organization_slug_key" ON "Organization"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "Membership_orgId_userId_key" ON "Membership"("orgId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "Invitation_token_key" ON "Invitation"("token");

-- CreateIndex
CREATE INDEX "Invitation_email_idx" ON "Invitation"("email");

-- AddForeignKey
ALTER TABLE "Membership" ADD CONSTRAINT "Membership_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Membership" ADD CONSTRAINT "Membership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invitation" ADD CONSTRAINT "Invitation_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Data backfill (hand-written, idempotent-safe on an empty DB)
-- ---------------------------------------------------------------------------

-- (2) Add Document.orgId as NULLABLE first so existing rows survive.
ALTER TABLE "Document" ADD COLUMN "orgId" TEXT;

-- (3) Create the default Organization to home all pre-existing data.
INSERT INTO "Organization" ("id", "name", "slug", "createdAt")
VALUES ('org_default00000000000000000', 'Default Organization', 'default', CURRENT_TIMESTAMP);

-- (4) Give every existing User an owner Membership in the default org.
INSERT INTO "Membership" ("id", "orgId", "userId", "role", "createdAt")
SELECT 'mbr_' || "id", 'org_default00000000000000000', "id", 'owner', CURRENT_TIMESTAMP
FROM "User";

-- (5) Home every existing Document in the default org.
UPDATE "Document" SET "orgId" = 'org_default00000000000000000' WHERE "orgId" IS NULL;

-- (6) Now that every row has an org, enforce NOT NULL + the FK.
ALTER TABLE "Document" ALTER COLUMN "orgId" SET NOT NULL;

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
