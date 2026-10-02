// The sender's personal note in a signing invitation.
//
// The send box is PRE-FILLED with the default below (or the note used last time
// for this document) so senders edit a sensible message rather than write one
// from nothing. Clearing the box sends no note at all.
export const DEFAULT_INVITE_MESSAGE =
  'Please review and sign this document. Let me know if you have any questions.'

export const MAX_INVITE_MESSAGE = 2000

// Normalise what the sender typed: trimmed, capped, and empty → null (no note).
// Anything that isn't a string is treated as no note.
export function normalizeInviteMessage(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const v = raw.replace(/\r\n?/g, '\n').trim().slice(0, MAX_INVITE_MESSAGE)
  return v.length ? v : null
}
