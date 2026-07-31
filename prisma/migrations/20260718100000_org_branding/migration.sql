-- Phase 5 — white-label per-org branding. Additive + nullable, so existing orgs
-- (NULL on all three) keep the generic Ezy Sign identity everywhere.
-- AlterTable
ALTER TABLE "Organization" ADD COLUMN     "brandColor" TEXT;
ALTER TABLE "Organization" ADD COLUMN     "brandName" TEXT;
ALTER TABLE "Organization" ADD COLUMN     "logoKey" TEXT;
