// Pure envelope helpers (no DB / no I/O) — unit-tested.
import type { DocStatus } from '@prisma/client'

export type EnvelopeStatus = 'draft' | 'partial' | 'sent' | 'completed'

/**
 * An envelope's status is DERIVED from its documents, never stored, so it can
 * never disagree with them:
 *  - draft:     nothing has been sent yet (also an empty envelope);
 *  - partial:   some documents went out and some are still drafts;
 *  - sent:      every document went out and at least one is still open
 *               (a declined document counts as out, not done);
 *  - completed: every document is completed or self-signed.
 */
export function deriveEnvelopeStatus(statuses: readonly DocStatus[]): EnvelopeStatus {
  if (statuses.length === 0) return 'draft'
  const drafts = statuses.filter((s) => s === 'draft').length
  if (drafts === statuses.length) return 'draft'
  if (drafts > 0) return 'partial'
  if (statuses.every((s) => s === 'completed' || s === 'signed')) return 'completed'
  return 'sent'
}

export type SignerInput = { name: string; email: string }

/**
 * Clean the signer list an envelope sender typed: trimmed, emails lowercased,
 * blanks dropped, duplicates (by email) collapsed to the first. Returns null if
 * any remaining row lacks a name or has an invalid email.
 */
export function normalizeSigners(rows: readonly SignerInput[]): SignerInput[] | null {
  const seen = new Set<string>()
  const out: SignerInput[] = []
  for (const r of rows) {
    const name = (r.name ?? '').trim()
    const email = (r.email ?? '').trim().toLowerCase()
    if (!name && !email) continue
    if (!name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254 || name.length > 120) return null
    if (seen.has(email)) continue
    seen.add(email)
    out.push({ name, email })
  }
  return out
}
