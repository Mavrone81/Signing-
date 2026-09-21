import { z } from 'zod'

// A single email address typed by an admin (e.g. the test-email recipient).
// Used both when the action accepts it and when the page echoes it back from a
// query string, so a crafted link can't make the page print arbitrary text.
export const emailRecipientSchema = z.string().trim().toLowerCase().max(254).pipe(z.email())

export function parseEmailRecipient(raw: unknown): string | null {
  const r = emailRecipientSchema.safeParse(typeof raw === 'string' ? raw : '')
  return r.success ? r.data : null
}
