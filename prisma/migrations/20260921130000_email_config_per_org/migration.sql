-- Per-organization SMTP with a shared fallback.
--
-- The existing deployment-wide row is KEPT exactly as it is (same id, same
-- encrypted password) and becomes the shared fallback server simply by having no
-- org. Nothing is backfilled: every org without its own server keeps sending
-- through the shared one, so no existing mail stops at deploy. Orgs add their
-- own server later from Settings → Email. One transaction: any failure leaves
-- the table exactly as it was.
BEGIN;

-- Nullable: NULL = the shared server; set = that org's own server.
ALTER TABLE "EmailConfig" ADD COLUMN "orgId" TEXT;

-- The table is no longer one row per provider. At most one row per org
-- (Postgres unique indexes allow many NULLs; the single shared row is enforced
-- by the settings action).
DROP INDEX "EmailConfig_provider_key";
CREATE UNIQUE INDEX "EmailConfig_orgId_key" ON "EmailConfig"("orgId");

-- An org's own server goes with it.
ALTER TABLE "EmailConfig" ADD CONSTRAINT "EmailConfig_orgId_fkey"
  FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

COMMIT;
