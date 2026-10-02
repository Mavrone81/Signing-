import { AuditAction, DocStatus, RecipientStatus, Prisma } from '@prisma/client'
import { prisma } from '@/lib/db'
import { finalizeSentDocument } from './actions'
import type { UploadMeta } from './actions'
import { notifyNextSequential, notifyCompleted, notifyDeclined } from './notify'
import {
  emitRecipientViewed,
  emitRecipientSigned,
  emitDocumentCompleted,
  emitDocumentDeclined,
} from './webhook-events'
import { isFieldFilled, type FieldOptions, type FieldType } from '@/components/pdf-editor/types'
import { resolveBrand, type ResolvedBrand } from '@/lib/branding'
import { SigningCertUnusableError } from '@/lib/signing-config'

// ---------------------------------------------------------------------------
// Phase 2b — recipient signing (`/sign/[token]`). THIS IS AN UNAUTHENTICATED
// SURFACE: the unguessable per-recipient `token` IS the authorization. Every
// entry point re-validates the token from scratch (never trusting a client id)
// and a recipient may only ever touch fields assigned to their OWN Recipient
// row on their OWN document. No org session is created or consulted here.
// ---------------------------------------------------------------------------

// Why a valid token still can't sign right now.
//  - not_found   : no recipient for this token (bad/expired/void link)
//  - inactive    : the document isn't in the `sent` state (draft/signed/
//                  completed/declined/voided) — signing is closed
//  - waiting     : sequential order, an earlier signer hasn't signed yet
//  - done_signed : this recipient already signed (thank-you state)
//  - done_declined : this recipient already declined
//  - expired     : the document's expiresAt has passed — signing is closed for
//                  everyone (Phase 4c). Enforced server-side here so a
//                  client-side check can never be bypassed.
export type SignerBlockReason =
  | 'not_found'
  | 'inactive'
  | 'waiting'
  | 'done_signed'
  | 'done_declined'
  | 'expired'

// A field as the recipient sees it. `mine` = assigned to THIS recipient (and so
// fillable); everything else is read-only context labelled with its assignee.
export interface SignerField {
  id: string
  page: number
  type: FieldType
  x: number
  y: number
  w: number
  h: number
  value: string
  style: unknown | null
  // Phase 4a: type-specific config (dropdown choices, radio group/label).
  options: FieldOptions | null
  // Phase 4a: whether this field must be filled (optional fields may be blank).
  required: boolean
  mine: boolean
  // Display label for a non-`mine` field: the assignee's name, or "Sender" for
  // an unassigned (self) field the sender pre-filled.
  assigneeLabel: string
  // Palette index for colour-coding (recipient position; -1 for a self field).
  colorIndex: number
}

export interface SignerContext {
  ok: true
  token: string
  recipient: { id: string; name: string; email: string }
  document: { originalName: string; signingOrder: 'parallel' | 'sequential' }
  // Phase 5 — the tenant org's resolved white-label brand (name/colour/logoKey).
  // The signer is unauthenticated, so this is surfaced ONLY through the token
  // (scoped to this document's org) — never a generic public lookup. The page
  // inlines the logo blob as a data URI from `brand.logoKey`. `customized` false
  // ⇒ the signer shows the generic Bevora Sign identity (exactly as before).
  brand: ResolvedBrand
  fields: SignerField[]
  // How many of THIS recipient's fields there are (drives the finish gate).
  myFieldCount: number
}

export type SignerResult = SignerContext | { ok: false; reason: SignerBlockReason }

// Internal: the fully-loaded recipient + document + all fields + all recipients
// for a token, or null. Never leaks other tokens.
async function loadRecipient(token: string) {
  if (!token || typeof token !== 'string') return null
  return prisma.recipient.findUnique({
    where: { token },
    include: {
      document: {
        include: {
          recipients: { orderBy: { orderIndex: 'asc' } },
          fields: { orderBy: { createdAt: 'asc' } },
          // The tenant org's brand — surfaced to the signer via the token only.
          org: { select: { name: true, brandName: true, brandColor: true, logoKey: true } },
        },
      },
    },
  })
}

// Core validation shared by every entry point. Returns the loaded rows on
// success, or a block reason. Enforces: recipient exists; document is `sent`;
// this recipient hasn't already signed/declined; and, for sequential order,
// every lower-orderIndex recipient is already `signed` (this recipient's turn).
type LoadedRecipient = NonNullable<Awaited<ReturnType<typeof loadRecipient>>>

function validate(
  rec: LoadedRecipient | null,
): { ok: true; rec: LoadedRecipient } | { ok: false; reason: SignerBlockReason } {
  if (!rec) return { ok: false, reason: 'not_found' }
  const doc = rec.document
  // A token only authorizes signing while the document is actively out for
  // signature. draft/signed(self)/completed/declined all close the door.
  if (doc.status !== DocStatus.sent) {
    if (rec.status === RecipientStatus.signed) return { ok: false, reason: 'done_signed' }
    if (rec.status === RecipientStatus.declined) return { ok: false, reason: 'done_declined' }
    return { ok: false, reason: 'inactive' }
  }
  if (rec.status === RecipientStatus.signed) return { ok: false, reason: 'done_signed' }
  if (rec.status === RecipientStatus.declined) return { ok: false, reason: 'done_declined' }
  // Phase 4c — expiry: a `sent` document past its deadline is closed to every
  // recipient. Checked server-side (lazily, on access) so an expired link can
  // never sign regardless of any client-side state.
  if (doc.expiresAt && doc.expiresAt.getTime() < Date.now()) {
    return { ok: false, reason: 'expired' }
  }
  // Only pending/viewed may proceed.
  if (rec.status !== RecipientStatus.pending && rec.status !== RecipientStatus.viewed) {
    return { ok: false, reason: 'inactive' }
  }
  // Sequential: it must be this recipient's turn — every recipient ahead of
  // them (lower orderIndex) must already be `signed`.
  if (doc.signingOrder === 'sequential') {
    const blockedByEarlier = doc.recipients.some(
      (r) => r.orderIndex < rec.orderIndex && r.status !== RecipientStatus.signed,
    )
    if (blockedByEarlier) return { ok: false, reason: 'waiting' }
  }
  return { ok: true, rec }
}

// Builds the recipient-facing view (fields + labels) from a validated load.
function toContext(token: string, rec: LoadedRecipient): SignerContext {
  const doc = rec.document
  const orderIndexById = new Map(doc.recipients.map((r) => [r.id, r.orderIndex]))
  const nameById = new Map(doc.recipients.map((r) => [r.id, r.name]))

  const fields: SignerField[] = doc.fields.map((f) => {
    const mine = f.recipientId === rec.id
    const colorIndex = f.recipientId != null ? orderIndexById.get(f.recipientId) ?? -1 : -1
    const assigneeLabel = f.recipientId
      ? nameById.get(f.recipientId) ?? 'Recipient'
      : 'Sender'
    return {
      id: f.id,
      page: f.page,
      type: f.type,
      x: f.x,
      y: f.y,
      w: f.w,
      h: f.h,
      value: f.value,
      style: f.style ?? null,
      options: (f.options as unknown as FieldOptions | null) ?? null,
      required: f.required,
      mine,
      assigneeLabel,
      colorIndex,
    }
  })

  return {
    ok: true,
    token,
    recipient: { id: rec.id, name: rec.name, email: rec.email },
    document: {
      originalName: doc.originalName,
      signingOrder: doc.signingOrder as 'parallel' | 'sequential',
    },
    brand: resolveBrand(doc.org),
    fields,
    myFieldCount: fields.filter((f) => f.mine).length,
  }
}

/**
 * Loads + validates the signer context for a token. On the FIRST valid view of
 * a `pending` recipient, stamps `viewedAt` + status `viewed` (best-effort — a
 * failed stamp never blocks viewing). Never throws; returns a block reason for
 * any invalid/closed/out-of-turn/already-done token so the page can render a
 * friendly state instead of crashing.
 */
export async function viewSigner(token: string): Promise<SignerResult> {
  const rec = await loadRecipient(token)
  const v = validate(rec)
  if (!v.ok) return { ok: false, reason: v.reason }

  if (v.rec.status === RecipientStatus.pending) {
    let stamped = false
    try {
      const res = await prisma.recipient.updateMany({
        where: { id: v.rec.id, status: RecipientStatus.pending },
        data: { status: RecipientStatus.viewed, viewedAt: new Date() },
      })
      stamped = res.count > 0
    } catch {
      // Non-fatal: viewing must still work even if the view stamp fails.
    }
    // Best-effort `recipient.viewed` webhook — only on the first real view (the
    // pending→viewed transition we actually won), never blocks rendering.
    if (stamped) {
      try {
        await emitRecipientViewed(v.rec.document.id, v.rec.id)
      } catch (err) {
        console.error('[viewSigner] webhook failed:', err instanceof Error ? err.message : String(err))
      }
    }
  }
  return toContext(token, v.rec)
}

/**
 * Validates a token for streaming the original PDF to the signer's viewer.
 * Returns the document's storage key on success, or a block reason. The caller
 * (GET /api/sign/[token]) decrypts + streams that key — token-authorized, NOT
 * org-authorized.
 */
export async function signerFileKey(
  token: string,
): Promise<{ ok: true; originalKey: string; originalName: string } | { ok: false; reason: SignerBlockReason }> {
  const rec = await loadRecipient(token)
  const v = validate(rec)
  if (!v.ok) return { ok: false, reason: v.reason }
  return { ok: true, originalKey: v.rec.document.originalKey, originalName: v.rec.document.originalName }
}

export type CompleteResult =
  | { ok: true; completed: boolean }
  | { ok: false; reason: SignerBlockReason | 'invalid_values' }

/**
 * Completes THIS recipient's signing. `values` are their field values keyed by
 * fieldId. Every fieldId MUST belong to this recipient (a foreign fieldId is
 * rejected outright — no touching the sender's or other recipients' fields),
 * and every one of the recipient's fields must be non-empty (signature =
 * data:image; text/date = non-blank). Persists the values, flips the recipient
 * to `signed` (+ signedAt), and records a `sign` AuditEvent with the IP. If
 * this was the LAST outstanding recipient, finalizes the whole document
 * (flatten all fields + multi-signer certificate → status `completed`).
 */
export async function completeSigning(
  token: string,
  values: { fieldId: string; value: string }[],
  meta: UploadMeta = {},
): Promise<CompleteResult> {
  const rec = await loadRecipient(token)
  const v = validate(rec)
  if (!v.ok) return { ok: false, reason: v.reason }

  const myFields = v.rec.document.fields.filter((f) => f.recipientId === v.rec.id)
  const myFieldIds = new Set(myFields.map((f) => f.id))

  if (!Array.isArray(values)) return { ok: false, reason: 'invalid_values' }

  // Reject any value targeting a field that is not this recipient's own —
  // this is the field-scoping guard for the unauthenticated surface.
  const provided = new Map<string, string>()
  for (const v2 of values) {
    if (!v2 || typeof v2.fieldId !== 'string' || typeof v2.value !== 'string') {
      return { ok: false, reason: 'invalid_values' }
    }
    if (!myFieldIds.has(v2.fieldId)) return { ok: false, reason: 'invalid_values' }
    provided.set(v2.fieldId, v2.value)
  }

  // Every REQUIRED field must be filled (type-aware: signature/initials image;
  // checkbox 'true'; radio/dropdown/text/date a non-blank selection). OPTIONAL
  // fields may be omitted or left blank. A provided value must still be a
  // string (guaranteed above); the recipient must supply a value for each of
  // their required fields.
  for (const f of myFields) {
    const value = provided.get(f.id)
    if (f.required) {
      if (value == null || !isFieldFilled(f.type, value, true)) {
        return { ok: false, reason: 'invalid_values' }
      }
    }
  }

  // Persist the values + flip the recipient to signed + audit, atomically.
  // The recipient update is guarded on its current status so a double-submit
  // (two concurrent completes for the same token) can only win once.
  const guarded = await prisma.$transaction(async (tx) => {
    const flip = await tx.recipient.updateMany({
      where: {
        id: v.rec.id,
        status: { in: [RecipientStatus.pending, RecipientStatus.viewed] },
      },
      data: { status: RecipientStatus.signed, signedAt: new Date() },
    })
    if (flip.count === 0) return false // already signed/declined — lost the race
    for (const f of myFields) {
      // Optional fields may be omitted from the payload — leave those untouched.
      const val = provided.get(f.id)
      if (val === undefined) continue
      await tx.field.update({ where: { id: f.id }, data: { value: val } })
    }
    await tx.auditEvent.create({
      data: {
        documentId: v.rec.document.id,
        userId: null,
        action: AuditAction.sign,
        ip: meta.ip ?? null,
        userAgent: meta.userAgent ?? null,
        detail: {
          recipientId: v.rec.id,
          recipientEmail: v.rec.email,
          recipientName: v.rec.name,
        } as Prisma.InputJsonValue,
      },
    })
    return true
  })

  if (!guarded) {
    // Someone else already advanced this recipient; re-read to report why.
    const after = validate(await loadRecipient(token))
    return { ok: false, reason: after.ok ? 'inactive' : after.reason }
  }

  // Best-effort `recipient.signed` webhook — this recipient just signed. Never
  // affects the (already-committed) signing result.
  try {
    await emitRecipientSigned(v.rec.document.id, v.rec.id)
  } catch (err) {
    console.error('[completeSigning] webhook signed failed:', err instanceof Error ? err.message : String(err))
  }

  // Are all recipients now signed? If so, finalize the whole document.
  const remaining = await prisma.recipient.count({
    where: { documentId: v.rec.document.id, status: { not: RecipientStatus.signed } },
  })
  if (remaining > 0) {
    // Sequential: it's now the next recipient's turn — email them their link.
    // Best-effort: a mail failure must not affect the signing result.
    try {
      await notifyNextSequential(v.rec.document.id, meta.baseUrl)
    } catch (err) {
      console.error('[completeSigning] notify next failed:', err instanceof Error ? err.message : String(err))
    }
    return { ok: true, completed: false }
  }

  // Gather each signer's recorded IP (from their `sign` AuditEvent) for the cert.
  const signEvents = await prisma.auditEvent.findMany({
    where: { documentId: v.rec.document.id, action: AuditAction.sign },
  })
  const signerIps = new Map<string, string | null>()
  for (const e of signEvents) {
    const rid = (e.detail as { recipientId?: string } | null)?.recipientId
    if (rid && !signerIps.has(rid)) signerIps.set(rid, e.ip)
  }

  // Fail-closed sealing throws here in two families: SIGNING_NOT_CONFIGURED
  // (env.SIGNING_FAIL_CLOSED on, org has no cert) or a SigningCertUnusableError
  // subclass (unconditional — the org's active cert is expired or not yet
  // valid). This recipient's signature is already committed above — losing
  // it because sealing cannot proceed would be its own kind of data loss —
  // so either is caught, logged, and treated like "not completed yet" (res
  // stays null) rather than crashing the signer-facing response. The
  // document stays `sent`; nothing else re-attempts finalize until someone
  // calls it again (e.g. after the admin configures/replaces the certificate).
  let res: Awaited<ReturnType<typeof finalizeSentDocument>> = null
  try {
    res = await finalizeSentDocument(v.rec.document.id, signerIps)
  } catch (err) {
    const sealingBlocked =
      err instanceof SigningCertUnusableError ||
      (err instanceof Error && err.message === 'SIGNING_NOT_CONFIGURED')
    if (sealingBlocked) {
      console.error(`[completeSigning] document ${v.rec.document.id} fully signed but cannot be sealed: ${(err as Error).message}`)
    } else {
      throw err
    }
  }
  // All signed → completed: email the sender + every recipient (signed PDF
  // attached). Best-effort — never affects the completion result.
  if (res != null) {
    try {
      await notifyCompleted(v.rec.document.id, meta.baseUrl)
    } catch (err) {
      console.error('[completeSigning] notify completed failed:', err instanceof Error ? err.message : String(err))
    }
    // Best-effort `document.completed` webhook — all recipients have signed.
    try {
      await emitDocumentCompleted(v.rec.document.id)
    } catch (err) {
      console.error('[completeSigning] webhook completed failed:', err instanceof Error ? err.message : String(err))
    }
  }
  return { ok: true, completed: res != null }
}

export type DeclineResult =
  | { ok: true }
  | { ok: false; reason: SignerBlockReason }

/**
 * Declines signing for THIS recipient: flips the recipient to `declined`
 * (+ declinedAt), flips the whole Document to `declined` (no one else can sign
 * once one recipient refuses), and records a `decline` AuditEvent with the IP.
 */
export async function declineSigning(token: string, meta: UploadMeta = {}): Promise<DeclineResult> {
  const rec = await loadRecipient(token)
  const v = validate(rec)
  if (!v.ok) return { ok: false, reason: v.reason }

  await prisma.$transaction(async (tx) => {
    const flip = await tx.recipient.updateMany({
      where: {
        id: v.rec.id,
        status: { in: [RecipientStatus.pending, RecipientStatus.viewed] },
      },
      data: { status: RecipientStatus.declined, declinedAt: new Date() },
    })
    if (flip.count === 0) return
    await tx.document.update({
      where: { id: v.rec.document.id },
      data: { status: DocStatus.declined },
    })
    await tx.auditEvent.create({
      data: {
        documentId: v.rec.document.id,
        userId: null,
        action: AuditAction.decline,
        ip: meta.ip ?? null,
        userAgent: meta.userAgent ?? null,
        detail: {
          recipientId: v.rec.id,
          recipientEmail: v.rec.email,
          recipientName: v.rec.name,
        } as Prisma.InputJsonValue,
      },
    })
  })

  // Best-effort: notify the sender that this recipient declined. A mail failure
  // must not affect the decline result.
  try {
    await notifyDeclined(v.rec.document.id, v.rec.id, meta.baseUrl)
  } catch (err) {
    console.error('[declineSigning] notify declined failed:', err instanceof Error ? err.message : String(err))
  }

  // Best-effort `document.declined` webhook — one recipient refused, so the
  // whole document is declined. Never affects the (already-committed) result.
  try {
    await emitDocumentDeclined(v.rec.document.id, v.rec.id)
  } catch (err) {
    console.error('[declineSigning] webhook declined failed:', err instanceof Error ? err.message : String(err))
  }

  return { ok: true }
}
