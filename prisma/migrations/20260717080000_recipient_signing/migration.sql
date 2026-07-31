-- Phase 2b: recipient signing at /sign/[token] + multi-signer finalize.
--
-- Additive + one relaxation:
--   * Two new AuditAction values for the recipient-facing lifecycle.
--   * AuditEvent.userId becomes nullable: a recipient `sign`/`decline` (and the
--     multi-signer `finalize` that completes the document) is performed by an
--     unauthenticated recipient, not a User — the recipient's identity is
--     carried in AuditEvent.detail instead. Existing rows keep their userId.

-- AlterEnum: recipient signing actions.
ALTER TYPE "AuditAction" ADD VALUE 'sign';
ALTER TYPE "AuditAction" ADD VALUE 'decline';

-- AlterTable: recipient-driven audit events have no User.
ALTER TABLE "AuditEvent" ALTER COLUMN "userId" DROP NOT NULL;
