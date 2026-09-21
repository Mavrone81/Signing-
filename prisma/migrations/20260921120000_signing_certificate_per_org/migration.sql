-- Per-organization signing certificates.
--
-- Turns the deployment-wide certificate table into per-org rows WITHOUT
-- recreating any row: an existing certificate keeps its id, blob and passphrase
-- and is handed to one org. All steps run in one transaction, so any failure
-- leaves the table exactly as it was.
BEGIN;

-- 1. Nullable first, so existing rows survive the column add.
ALTER TABLE "SigningCertificate" ADD COLUMN "orgId" TEXT;

-- 2. Hand every existing certificate to the org with slug 'default', or, if
--    there is none, the oldest org. Resolved by slug/age, never by a literal
--    id, because ids differ between environments.
UPDATE "SigningCertificate"
SET "orgId" = (
  SELECT "id" FROM "Organization"
  ORDER BY ("slug" = 'default') DESC, "createdAt" ASC, "id" ASC
  LIMIT 1
)
WHERE "orgId" IS NULL;

-- 3. Fail closed with a readable message if a certificate exists but no org
--    does, instead of a bare NOT NULL violation in step 4.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "SigningCertificate" WHERE "orgId" IS NULL) THEN
    RAISE EXCEPTION 'signing_certificate_per_org: a signing certificate exists but there is no organization to assign it to. Create an organization first; no rows were changed.';
  END IF;
END $$;

-- 4. Now that every row has an org, enforce it.
ALTER TABLE "SigningCertificate" ALTER COLUMN "orgId" SET NOT NULL;

-- 5. The lookup is always "this org's active certificate". Not unique: replaced
--    certificates are kept inactive for audit.
DROP INDEX "SigningCertificate_active_idx";
CREATE INDEX "SigningCertificate_orgId_active_idx" ON "SigningCertificate"("orgId", "active");

-- 6. An org's certificates go with it.
ALTER TABLE "SigningCertificate" ADD CONSTRAINT "SigningCertificate_orgId_fkey"
  FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

COMMIT;
