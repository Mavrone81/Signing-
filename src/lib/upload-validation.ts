// Client-side pre-checks only — a fast rejection for obviously-wrong files
// so the user isn't left waiting on a network round trip. The server
// (`createDocument` in `src/server/documents/actions.ts`) is the
// authoritative check: magic-byte sniff + pdf-lib parse + byte-length limit.
// This mirrors env.MAX_UPLOAD_MB's default; the server enforces the real
// (env-configured) limit regardless of what's checked here.
export const CLIENT_MAX_UPLOAD_MB = 25;

export function isLikelyPdf(file: { name: string; type?: string }): boolean {
  const nameOk = file.name.toLowerCase().endsWith(".pdf");
  const typeOk = !file.type || file.type === "application/pdf";
  return nameOk && typeOk;
}

export function isUnderClientSizeCap(
  file: { size: number },
  maxMb: number = CLIENT_MAX_UPLOAD_MB
): boolean {
  return file.size <= maxMb * 1024 * 1024;
}
