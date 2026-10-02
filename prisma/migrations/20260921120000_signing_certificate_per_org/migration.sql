-- Per-organization signing certificates.
--
-- Turns the deployment-wide certificate table into per-org rows WITHOUT ever
-- guessing an owner across tenants: an existing certificate is attached to an
-- org only when there is EXACTLY ONE org to attach it to. With any other org
-- count it is left UNASSIGNED (orgId stays NULL, permanently — the column is
-- nullable, not just nullable-during-migration) rather than assigned to a
-- org that may never have generated or uploaded it. A live deployment can
-- have any number of pre-existing organizations (owner ruling: orgs are
-- created by users at any time), so this migration must succeed regardless of that
-- count — it never aborts just because more than one org exists. An
-- unassigned certificate cannot seal anything: every org, including the ones
-- that didn't get this legacy certificate, fails closed on sealing
-- (src/lib/signing-config.ts) until its own admin generates or uploads one in
-- Settings -> Signing. All steps run in one transaction, so any failure
-- leaves the table exactly as it was.
BEGIN;

-- 1. Nullable, and stays nullable — see above.
ALTER TABLE "SigningCertificate" ADD COLUMN "orgId" TEXT;

-- 2. Lock out concurrent org creation for the rest of this transaction. SHARE
--    mode conflicts with the ROW EXCLUSIVE lock an INSERT takes, so an org
--    created in the window between "count the orgs" and "act on that count"
--    simply blocks until we commit or roll back — the count read below is a
--    real run-time fact for the whole transaction, never a preflight that a
--    concurrent signup could make stale. The lock is held only for this
--    migration's own duration (milliseconds at this data's size), and an org
--    created right after this transaction commits is already correctly
--    handled: it has no certificate of its own, so it fails closed on
--    sealing exactly like any other org without one.
LOCK TABLE "Organization" IN SHARE MODE;

-- 3. Attach only when the count is unambiguous. The only other case that
--    changes anything is zero organizations: a certificate with nothing to
--    possibly belong to is almost certainly a data problem, not a fresh
--    install (a fresh install has no certificate rows either), so that case
--    still fails closed with a readable, actionable message instead of
--    silently doing nothing. Two or more organizations is the ordinary,
--    expected shape of a live deployment and is handled by the ELSE
--    below (falling through, changing nothing) — not by this DO block.
DO $$
DECLARE
  org_count INTEGER := (SELECT COUNT(*) FROM "Organization");
  only_org_id TEXT;
BEGIN
  IF org_count = 1 THEN
    SELECT "id" INTO only_org_id FROM "Organization" LIMIT 1;
    UPDATE "SigningCertificate" SET "orgId" = only_org_id WHERE "orgId" IS NULL;
  ELSIF org_count = 0 THEN
    IF EXISTS (SELECT 1 FROM "SigningCertificate" WHERE "orgId" IS NULL) THEN
      RAISE EXCEPTION 'signing_certificate_per_org: a signing certificate exists but there is no organization to assign it to. Create an organization first; no rows were changed.';
    END IF;
  END IF;
  -- org_count > 1: leave every unassigned certificate exactly as it is —
  -- which org generated or uploaded it cannot be recovered from the old
  -- deployment-wide table, and guessing would be the cross-tenant assignment
  -- this feature exists to prevent. Not an error: a live multi-org
  -- deployment is the expected, common case this migration must ship on.
END $$;

-- 4. The lookup is always "this org's active certificate". Not unique: replaced
--    certificates are kept inactive for audit.
DROP INDEX "SigningCertificate_active_idx";
CREATE INDEX "SigningCertificate_orgId_active_idx" ON "SigningCertificate"("orgId", "active");

-- 5. An org's certificates go with it. orgId stays nullable (see above), so
--    this FK is silently satisfied for any row left unassigned.
ALTER TABLE "SigningCertificate" ADD CONSTRAINT "SigningCertificate_orgId_fkey"
  FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

COMMIT;
