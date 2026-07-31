-- CreateTable
CREATE TABLE "SigningCertificate" (
    "id" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "p12Key" TEXT NOT NULL,
    "passphraseEnc" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "issuer" TEXT NOT NULL,
    "serial" TEXT,
    "notBefore" TIMESTAMP(3) NOT NULL,
    "notAfter" TIMESTAMP(3) NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "tsaUrl" TEXT,
    "origin" TEXT NOT NULL DEFAULT 'uploaded',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT,

    CONSTRAINT "SigningCertificate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SigningCertificate_active_idx" ON "SigningCertificate"("active");
