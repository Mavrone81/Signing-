-- Phase 4a: more field types (checkbox, initials, radio, dropdown) + a
-- required/optional flag and per-field options config.
--
-- Fully ADDITIVE + backward-compatible: existing signature/date/text fields
-- keep working; every existing Field row defaults to required = true and
-- options = NULL. No backfill needed.

-- AlterEnum: new field types. (Adding values only — none are used within this
-- migration's transaction, so this is safe on PostgreSQL 12+.)
ALTER TYPE "FieldType" ADD VALUE 'checkbox';
ALTER TYPE "FieldType" ADD VALUE 'initials';
ALTER TYPE "FieldType" ADD VALUE 'radio';
ALTER TYPE "FieldType" ADD VALUE 'dropdown';

-- AlterTable: required flag (defaults true so existing rows stay required) +
-- per-field options config (radio group/label, dropdown choices).
ALTER TABLE "Field" ADD COLUMN "required" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Field" ADD COLUMN "options" JSONB;
