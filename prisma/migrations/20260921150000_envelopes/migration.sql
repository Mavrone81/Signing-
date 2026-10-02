-- Envelopes: a thin grouping of documents sent to the same people together,
-- plus each signer's single link. Additive only: new tables and a nullable
-- Document.envelopeId, so existing documents are untouched.

-- AlterTable
ALTER TABLE "Document" ADD COLUMN     "envelopeId" TEXT;

-- CreateTable
CREATE TABLE "Envelope" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "inviteMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Envelope_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EnvelopeSigner" (
    "id" TEXT NOT NULL,
    "envelopeId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "orderIndex" INTEGER NOT NULL DEFAULT 0,
    "token" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EnvelopeSigner_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Envelope_orgId_ownerId_idx" ON "Envelope"("orgId", "ownerId");

-- CreateIndex
CREATE UNIQUE INDEX "EnvelopeSigner_token_key" ON "EnvelopeSigner"("token");

-- CreateIndex
CREATE UNIQUE INDEX "EnvelopeSigner_envelopeId_email_key" ON "EnvelopeSigner"("envelopeId", "email");

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_envelopeId_fkey" FOREIGN KEY ("envelopeId") REFERENCES "Envelope"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Envelope" ADD CONSTRAINT "Envelope_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Envelope" ADD CONSTRAINT "Envelope_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EnvelopeSigner" ADD CONSTRAINT "EnvelopeSigner_envelopeId_fkey" FOREIGN KEY ("envelopeId") REFERENCES "Envelope"("id") ON DELETE CASCADE ON UPDATE CASCADE;

