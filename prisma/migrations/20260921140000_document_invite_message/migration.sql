-- The sender's personal note in the signing invitation. Nullable, no backfill:
-- existing documents simply have no note.
ALTER TABLE "Document" ADD COLUMN "inviteMessage" TEXT;
