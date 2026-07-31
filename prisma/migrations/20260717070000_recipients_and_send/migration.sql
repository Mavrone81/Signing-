-- Send-for-signature (Phase 2a): Recipient model + Field.recipientId
-- assignment + Document.signingOrder/sentAt + extended DocStatus/AuditAction.
--
-- Fully ADDITIVE: existing Documents keep their draft/signed status and their
-- fields (recipientId defaults to NULL = self-sign). No backfill needed.

-- AlterEnum: new document lifecycle states for sent documents.
ALTER TYPE "DocStatus" ADD VALUE 'sent';
ALTER TYPE "DocStatus" ADD VALUE 'completed';
ALTER TYPE "DocStatus" ADD VALUE 'declined';

-- AlterEnum: audit the send-for-signature action.
ALTER TYPE "AuditAction" ADD VALUE 'send';

-- CreateEnum
CREATE TYPE "SigningOrder" AS ENUM ('parallel', 'sequential');

-- CreateEnum
CREATE TYPE "RecipientStatus" AS ENUM ('pending', 'viewed', 'signed', 'declined');

-- AlterTable: signing order + sent timestamp on the document.
ALTER TABLE "Document" ADD COLUMN "signingOrder" "SigningOrder" NOT NULL DEFAULT 'parallel';
ALTER TABLE "Document" ADD COLUMN "sentAt" TIMESTAMP(3);

-- AlterTable: field → recipient assignment (NULL = the sender's own field).
ALTER TABLE "Field" ADD COLUMN "recipientId" TEXT;

-- CreateTable
CREATE TABLE "Recipient" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "orderIndex" INTEGER NOT NULL DEFAULT 0,
    "status" "RecipientStatus" NOT NULL DEFAULT 'pending',
    "token" TEXT NOT NULL,
    "viewedAt" TIMESTAMP(3),
    "signedAt" TIMESTAMP(3),
    "declinedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Recipient_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Recipient_token_key" ON "Recipient"("token");

-- CreateIndex
CREATE INDEX "Recipient_documentId_idx" ON "Recipient"("documentId");

-- CreateIndex
CREATE INDEX "Recipient_token_idx" ON "Recipient"("token");

-- CreateIndex
CREATE INDEX "Field_recipientId_idx" ON "Field"("recipientId");

-- AddForeignKey
ALTER TABLE "Recipient" ADD CONSTRAINT "Recipient_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Field" ADD CONSTRAINT "Field_recipientId_fkey" FOREIGN KEY ("recipientId") REFERENCES "Recipient"("id") ON DELETE SET NULL ON UPDATE CASCADE;
