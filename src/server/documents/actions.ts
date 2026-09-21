import { randomUUID } from 'crypto'
import { PDFDocument } from 'pdf-lib'
import { AuditAction, DocStatus, FieldType, OrgRole, Prisma } from '@prisma/client'
import { uid } from '@/lib/uid'
import { prisma } from '@/lib/db'
import { putObject, getObject, deleteObject } from '@/lib/storage'
import { sha256hex } from '@/lib/hash'
import { flattenPdf, DEFAULT_TEXT_STYLE, type FlatField, type TextStyle } from '@/server/pdf/flatten'
import { isFieldFilled, type FieldOptions } from '@/components/pdf-editor/types'
import { appendCertificate, appendMultiSignerCertificate } from '@/server/pdf/certificate'
import { maybePadesSign } from '@/lib/signing-config'
import { notifyOnSend } from '@/server/documents/notify'
import { emitDocumentSent } from '@/server/documents/webhook-events'
import { canAccessDocument } from '@/lib/rbac'
import { env } from '@/env'

const PDF_MAGIC = '%PDF-'

export interface UploadMeta {
  ip?: string | null
  userAgent?: string | null
  // Phase 3: the resolved live origin (e.g. request origin) so notification
  // emails can build absolute signing links. Optional — notify falls back to
  // AUTH_URL when absent.
  baseUrl?: string | null
}

/**
 * Validates, encrypts + stores, and registers a newly-uploaded PDF as a
 * draft Document owned by `ownerId`. Fails closed: any validation failure
 * throws before anything is written to storage or the database.
 *
 * Throws:
 *  - Error('TOO_LARGE')   — bytes.length exceeds env.MAX_UPLOAD_MB
 *  - Error('INVALID_PDF') — missing `%PDF-` magic bytes, or pdf-lib can't
 *                           parse the file (e.g. corrupt/truncated PDF)
 */
export async function createDocument(
  ownerId: string,
  orgId: string,
  name: string,
  bytes: Buffer,
  meta: UploadMeta = {}
): Promise<{ id: string; pageCount: number }> {
  const maxBytes = env.MAX_UPLOAD_MB * 1024 * 1024
  if (bytes.length > maxBytes) throw new Error('TOO_LARGE')

  if (bytes.subarray(0, 5).toString('latin1') !== PDF_MAGIC) {
    throw new Error('INVALID_PDF')
  }

  let pageCount: number
  try {
    const pdf = await PDFDocument.load(bytes)
    pageCount = pdf.getPageCount()
  } catch {
    throw new Error('INVALID_PDF')
  }

  const originalSha256 = sha256hex(bytes)
  const id = randomUUID()
  const originalKey = `${id}/original.pdf`

  // Store the encrypted blob before creating any DB row, so a failure here
  // never leaves a Document pointing at content that was never written.
  await putObject(originalKey, bytes)

  // Document + AuditEvent must commit together: a failure between the two
  // writes would otherwise leave a Document with no upload audit trail.
  const doc = await prisma.$transaction(async (tx) => {
    const d = await tx.document.create({
      data: {
        id,
        ownerId,
        orgId,
        originalName: name,
        status: DocStatus.draft,
        originalKey,
        originalSha256,
        pageCount,
      },
    })

    await tx.auditEvent.create({
      data: {
        documentId: d.id,
        userId: ownerId,
        action: AuditAction.upload,
        ip: meta.ip ?? null,
        userAgent: meta.userAgent ?? null,
      },
    })

    return d
  })

  return { id: doc.id, pageCount }
}

const FIELD_TYPES: ReadonlySet<string> = new Set([
  'signature',
  'date',
  'text',
  // Phase 4a
  'checkbox',
  'initials',
  'radio',
  'dropdown',
])

// Coerce an arbitrary (untrusted) options payload into a clean FieldOptions for
// the given type, or null for types that carry no options. Never throws — bad
// data falls back to sensible empties so a save is never blocked by options.
function coerceOptions(type: string, raw: unknown): FieldOptions | null {
  if (type !== 'dropdown' && type !== 'radio') return null
  const s = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  if (type === 'dropdown') {
    const choices = Array.isArray(s.choices)
      ? s.choices.filter((c): c is string => typeof c === 'string')
      : []
    return { choices }
  }
  // radio
  return {
    group: typeof s.group === 'string' ? s.group : '',
    label: typeof s.label === 'string' ? s.label : '',
  }
}

const HEX_RE = /^#[0-9a-fA-F]{6}$/

// Coerce an arbitrary (untrusted) style payload into a valid TextStyle,
// clamping/falling back per-field so a bad style NEVER blocks a save. Anything
// unrecognized reverts to the corresponding DEFAULT_TEXT_STYLE value rather
// than throwing.
function coerceTextStyle(raw: unknown): TextStyle {
  const d = DEFAULT_TEXT_STYLE
  if (!raw || typeof raw !== 'object') return { ...d }
  const s = raw as Record<string, unknown>

  const fontFamily =
    typeof s.fontFamily === 'string' && s.fontFamily.trim() ? s.fontFamily : d.fontFamily
  const sizeNum =
    typeof s.fontSize === 'number' && Number.isFinite(s.fontSize) ? s.fontSize : d.fontSize
  const fontSize = Math.min(96, Math.max(4, sizeNum))
  const color = typeof s.color === 'string' && HEX_RE.test(s.color) ? s.color : d.color
  const highlight =
    s.highlight === null
      ? null
      : typeof s.highlight === 'string' && HEX_RE.test(s.highlight)
        ? s.highlight
        : d.highlight
  const bold = typeof s.bold === 'boolean' ? s.bold : d.bold
  const italic = typeof s.italic === 'boolean' ? s.italic : d.italic
  const underline = typeof s.underline === 'boolean' ? s.underline : d.underline

  return { fontFamily, fontSize, color, highlight, bold, italic, underline }
}

/**
 * Replaces ALL Field rows for a document with `fields`. Every field is
 * validated first (coords normalized ∈ [0,1]; page an integer within the
 * document's page range; a known field type; a string value); any violation
 * throws Error('INVALID_FIELDS') before anything is written, so a bad payload
 * never partially replaces the saved placement.
 *
 * A signed (locked) document's field placement must never be overwritten —
 * the signed.pdf blob + signedSha256 were derived from the placement at
 * finalize time, so replacing the Field rows afterwards would desync the DB
 * from the locked artifact. Refusing here protects both the `PUT /fields`
 * route and `finalize()` (which calls this first to persist the latest
 * placement before signing).
 *
 * Throws:
 *  - Error('NOT_FOUND')         — no such document
 *  - Error('409 ALREADY_SIGNED') — the document is already signed (locked)
 *  - Error('INVALID_FIELDS')    — a coord out of [0,1], a bad page, bad type,
 *                                 or a non-string value
 */
export async function saveFields(docId: string, fields: FlatField[]): Promise<void> {
  const doc = await prisma.document.findUnique({ where: { id: docId } })
  if (!doc) throw new Error('NOT_FOUND')
  // Only a draft's placement may be replaced. A signed doc's blob was derived
  // from the placement at finalize time; a sent doc is locked while recipients
  // sign. Both surface as a 409 (see the route's ALREADY_SIGNED mapping).
  if (doc.status !== DocStatus.draft) throw new Error('409 ALREADY_SIGNED')

  // Valid recipient targets for this doc: a field may be assigned to null
  // (self) or to one of this document's own recipients — never a stray or
  // cross-document recipient id.
  const recipientRows = await prisma.recipient.findMany({
    where: { documentId: docId },
    select: { id: true },
  })
  const recipientIds = new Set(recipientRows.map((r) => r.id))

  for (const f of fields) {
    const coordsOk = [f.x, f.y, f.w, f.h].every(
      (n) => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1,
    )
    const pageOk = Number.isInteger(f.page) && f.page >= 1 && f.page <= doc.pageCount
    const typeOk = FIELD_TYPES.has(f.type)
    const valueOk = typeof f.value === 'string'
    // required, when present, must be a boolean (defaults to true when omitted).
    const requiredOk = f.required === undefined || typeof f.required === 'boolean'
    const recipientOk =
      f.recipientId == null || (typeof f.recipientId === 'string' && recipientIds.has(f.recipientId))
    if (!coordsOk || !pageOk || !typeOk || !valueOk || !requiredOk || !recipientOk)
      throw new Error('INVALID_FIELDS')
  }

  // Replace-all must be atomic: a crash between the delete and the insert would
  // otherwise wipe the saved placement and leave the document field-less.
  await prisma.$transaction([
    prisma.field.deleteMany({ where: { documentId: docId } }),
    prisma.field.createMany({
      data: fields.map((f) => ({
        documentId: docId,
        page: f.page,
        type: f.type as FieldType,
        x: f.x,
        y: f.y,
        w: f.w,
        h: f.h,
        value: f.value,
        // Only text fields carry a style; others store SQL NULL.
        style: f.type === 'text' ? (coerceTextStyle(f.style) as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
        // Phase 4a: default true; only dropdown/radio persist options (else NULL).
        required: f.required ?? true,
        options:
          f.type === 'dropdown' || f.type === 'radio'
            ? (coerceOptions(f.type, f.options) as unknown as Prisma.InputJsonValue)
            : Prisma.DbNull,
        assigneeId: null,
        // null = the sender's own/self-sign field.
        recipientId: f.recipientId ?? null,
      })),
    }),
  ])
}

/**
 * Flattens the saved fields onto the original PDF, appends a signature
 * certificate page, stores the result encrypted as `<docId>/signed.pdf`, and
 * locks the Document into `signed` status with an audit trail.
 *
 * The `signedSha256` is the hash of the FLATTENED bytes (the document with
 * fields drawn in, BEFORE the certificate page is appended). This is
 * deliberate and non-circular: the certificate page prints `signedSha256`, so
 * hashing the cert-appended bytes would fold the hash into its own input.
 *
 * Throws:
 *  - Error('NOT_FOUND')       — no such document
 *  - Error('409 ALREADY_SIGNED') — the document is already signed
 */
export async function finalize(
  docId: string,
  user: { id: string; name: string; email: string; role: string },
  ip: string | null,
): Promise<{ signedSha256: string }> {
  const doc = await prisma.document.findUnique({ where: { id: docId } })
  if (!doc) throw new Error('NOT_FOUND')
  // Self-sign finalize only applies to a draft. A signed doc is already locked;
  // a sent doc is on the recipient-signing path (Phase 2b finalizes it when all
  // recipients have signed), never via this self-sign path.
  if (doc.status !== DocStatus.draft) throw new Error('409 ALREADY_SIGNED')

  const fieldRows = await prisma.field.findMany({ where: { documentId: docId } })
  const fields: FlatField[] = fieldRows.map((f) => ({
    page: f.page,
    type: f.type,
    x: f.x,
    y: f.y,
    w: f.w,
    h: f.h,
    value: f.value,
    // Cast the stored Json back to TextStyle for text fields; flatten merges
    // null/partial with DEFAULT_TEXT_STYLE, so a legacy null is fine.
    style: f.type === 'text' ? (f.style as unknown as TextStyle | null) : null,
    options: f.options as unknown as FieldOptions | null,
    required: f.required,
  }))

  // Every REQUIRED field must be filled (optional fields may be blank). The
  // editor gates this client-side; enforce it server-side too so finalize can
  // never bake an empty required field into the signed PDF.
  if (fields.some((f) => !isFieldFilled(f.type, f.value, f.required ?? true))) {
    throw new Error('INCOMPLETE_FIELDS')
  }

  const originalBytes = await getObject(doc.originalKey)
  const flattened = await flattenPdf(originalBytes, fields)

  // Hash the flattened bytes (pre-certificate) — see the non-circular note above.
  const signedSha256 = sha256hex(Buffer.from(flattened))

  const signedAt = new Date()
  const finalBytes = await appendCertificate(flattened, {
    signerName: user.name,
    signerEmail: user.email,
    signedAt,
    ip,
    originalSha256: doc.originalSha256,
    signedSha256,
  })

  // PAdES/PKI seal — the LAST finalize step. "Activate when configured": if a
  // platform signing cert is active, the completed PDF (flattened + certificate
  // page) is sealed with a detached CMS signature (ETSI.CAdES.detached,
  // whole-file ByteRange); otherwise the bytes pass through UNCHANGED.
  const sealed = await maybePadesSign(finalBytes)

  const signedKey = `${docId}/signed.pdf`
  // Store the encrypted signed blob before the DB update, so a failure here
  // never marks a Document `signed` with a signedKey that points at nothing.
  await putObject(signedKey, Buffer.from(sealed))

  await prisma.$transaction(async (tx) => {
    await tx.document.update({
      where: { id: docId },
      data: {
        status: DocStatus.signed,
        signedKey,
        signedSha256,
        signedAt,
      },
    })
    await tx.auditEvent.create({
      data: {
        documentId: docId,
        userId: user.id,
        action: AuditAction.finalize,
        ip,
      },
    })
  })

  return { signedSha256 }
}

/**
 * Reverts a signed document back to `draft`: removes the signed blob and nulls
 * out every signed-* field so it can be re-edited and re-finalized. Idempotent
 * for a document that is already a draft (early return). Records a `reset`
 * audit event attributed to `actorUserId` (the user performing the reset, not
 * necessarily the document's owner — e.g. an admin resetting another user's
 * document).
 */
export async function resetToDraft(docId: string, actorUserId: string): Promise<void> {
  const doc = await prisma.document.findUnique({ where: { id: docId } })
  if (!doc) throw new Error('NOT_FOUND')
  if (doc.status === DocStatus.draft) return

  if (doc.signedKey) await deleteObject(doc.signedKey)

  await prisma.$transaction(async (tx) => {
    await tx.document.update({
      where: { id: docId },
      data: {
        status: DocStatus.draft,
        signedKey: null,
        signedSha256: null,
        signedAt: null,
      },
    })
    await tx.auditEvent.create({
      data: {
        documentId: docId,
        userId: actorUserId,
        action: AuditAction.reset,
      },
    })
  })
}

/**
 * Permanently deletes a Document: best-effort removes both encrypted blobs
 * (`originalKey` and, if present, `signedKey`), then deletes the Document row.
 * Field/Recipient/AuditEvent rows all cascade at the DB level (`onDelete:
 * Cascade` on each relation), so no manual child-row cleanup is needed here.
 * Works for a document in ANY status (draft/sent/completed/signed) — the
 * caller decides whether that's appropriate (the UI warns before deleting a
 * `sent` document, since its recipients' signing links stop working).
 *
 * Authorization is `canAccessDocument`: only the uploader may delete a document
 * (owner-only — org owners/admins get no override).
 * A missing document AND an unauthorized one (same-org non-owner, or a
 * different org entirely) are indistinguishable to the caller — both throw
 * NOT_FOUND — so the error can never be used to learn whether a document a
 * user isn't allowed to touch even exists (this deliberately never surfaces a
 * separate FORBIDDEN, unlike some other document routes).
 *
 * Blob removal is best-effort and wrapped independently per key: a missing or
 * already-deleted blob (deleteObject already tolerates ENOENT) or any other
 * storage error is logged and swallowed rather than thrown, because the
 * Document row is the source of truth for whether the document still exists —
 * a storage hiccup must never leave a "delete" that silently kept the DB row.
 *
 * Throws:
 *  - Error('NOT_FOUND') — no such document, or the acting user is not
 *    authorized to act on it (see canAccessDocument)
 */
export async function deleteDocument(
  docId: string,
  actor: { id: string; orgId: string | null; orgRole: OrgRole | null },
): Promise<void> {
  const doc = await prisma.document.findUnique({
    where: { id: docId },
    select: { id: true, ownerId: true, orgId: true, originalKey: true, signedKey: true },
  })
  if (!doc || !canAccessDocument(actor, doc)) throw new Error('NOT_FOUND')

  for (const key of [doc.originalKey, doc.signedKey]) {
    if (!key) continue
    try {
      await deleteObject(key)
    } catch (err) {
      console.error('[deleteDocument] blob delete failed:', key, err instanceof Error ? err.message : String(err))
    }
  }

  // Cascades Field/Recipient/AuditEvent rows (onDelete: Cascade on each).
  await prisma.document.delete({ where: { id: docId } })
}

/**
 * Finalizes a SENT document once every recipient has signed (Phase 2b): loads
 * the original, flattens EVERY field (all recipients + any self fields the
 * sender left unassigned), appends a multi-signer certificate listing every
 * signer, stores the encrypted `signed.pdf`, and flips Document.status →
 * `completed` (with signedKey/signedSha256/signedAt + a `finalize` AuditEvent).
 *
 * Idempotent + concurrency-guarded: only a document still in `sent` status is
 * finalized (a status guard on the terminal updateMany makes a concurrent
 * finalize a no-op), so the two-recipients-sign-at-once race can only complete
 * the document once. Returns null if the document was not in `sent` (already
 * completed by a concurrent call, or never sent).
 *
 * `signerIps` maps Recipient.id → the IP recorded on that recipient's `sign`
 * AuditEvent, so the certificate can print each signer's IP.
 */
export async function finalizeSentDocument(
  docId: string,
  signerIps: Map<string, string | null> = new Map(),
): Promise<{ signedSha256: string } | null> {
  const doc = await prisma.document.findUnique({
    where: { id: docId },
    include: { recipients: { orderBy: { orderIndex: 'asc' } }, fields: true },
  })
  if (!doc) throw new Error('NOT_FOUND')
  // Only a still-`sent` document is finalized here. `completed` (a concurrent
  // finalize already won) or any other status → nothing to do.
  if (doc.status !== DocStatus.sent) return null

  const fields: FlatField[] = doc.fields.map((f) => ({
    page: f.page,
    type: f.type,
    x: f.x,
    y: f.y,
    w: f.w,
    h: f.h,
    value: f.value,
    style: f.type === 'text' ? (f.style as unknown as TextStyle | null) : null,
    options: f.options as unknown as FieldOptions | null,
    required: f.required,
  }))

  const originalBytes = await getObject(doc.originalKey)
  const flattened = await flattenPdf(originalBytes, fields)

  // Non-circular hash: hash the flattened (pre-certificate) bytes — the cert
  // prints signedSha256 (see finalize() for the full rationale).
  const signedSha256 = sha256hex(Buffer.from(flattened))
  const signedAt = new Date()

  const finalBytes = await appendMultiSignerCertificate(flattened, {
    signers: doc.recipients.map((r) => ({
      name: r.name,
      email: r.email,
      // Every recipient is `signed` at this point, so signedAt is set; fall
      // back to now defensively.
      signedAt: r.signedAt ?? signedAt,
      ip: signerIps.get(r.id) ?? null,
    })),
    originalSha256: doc.originalSha256,
    signedSha256,
  })

  // PAdES/PKI seal — the LAST finalize step. "Activate when configured": if a
  // platform signing cert is active, the completed PDF is sealed with a detached
  // CMS signature (ETSI.CAdES.detached, whole-file ByteRange); otherwise the
  // bytes pass through UNCHANGED (byte-identical to the flatten-only path).
  const sealed = await maybePadesSign(finalBytes)

  const signedKey = `${docId}/signed.pdf`
  // Store the encrypted signed blob before the DB update (see finalize()).
  await putObject(signedKey, Buffer.from(sealed))

  // Guarded transition: only flip a doc that is still `sent`. If a concurrent
  // finalize already completed it, updateMany touches 0 rows and we skip the
  // audit event (the blob we wrote just harmlessly overwrote the winner's).
  const updated = await prisma.document.updateMany({
    where: { id: docId, status: DocStatus.sent },
    data: { status: DocStatus.completed, signedKey, signedSha256, signedAt },
  })
  if (updated.count === 0) return null

  await prisma.auditEvent.create({
    data: {
      documentId: docId,
      userId: null,
      action: AuditAction.finalize,
      detail: { recipientCount: doc.recipients.length } as Prisma.InputJsonValue,
    },
  })

  return { signedSha256 }
}

// ---------------------------------------------------------------------------
// Send-for-signature (Phase 2a) — sender side only. The recipient signing
// experience (`/sign/[token]`) and the finalize-on-all-signed logic are
// Phase 2b; here we only model recipients, field assignment, and the send.
// ---------------------------------------------------------------------------

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export interface RecipientInput {
  // Client-supplied stable id (uid()). Reused as the DB row id so the editor's
  // field.recipientId references resolve without a name→id round-trip. Optional:
  // a missing id gets one minted server-side.
  id?: string
  name: string
  email: string
  orderIndex?: number
}

export interface SavedRecipient {
  id: string
  name: string
  email: string
  orderIndex: number
  status: string
  token: string
}

/**
 * Replaces ALL Recipient rows for a document with `recipients` (replace-all,
 * mirroring saveFields). Only a draft's recipients may be edited. Each recipient
 * is validated (non-empty name, well-formed email) before anything is written.
 *
 * NOTE ON FIELD ASSIGNMENT: because Field.recipientId → Recipient.id is
 * onDelete SetNull, deleting the old recipient rows here transiently unassigns
 * any fields pointing at them. The editor always re-saves fields (carrying the
 * same client recipient ids, which are reused as the new row ids) immediately
 * after saving recipients, so assignments are restored. Callers that change
 * recipients MUST re-save fields to persist assignments.
 *
 * Throws:
 *  - Error('NOT_FOUND')          — no such document
 *  - Error('409 ALREADY_SIGNED') — the document is not a draft (locked)
 *  - Error('INVALID_RECIPIENTS') — empty name, malformed email, or dup email
 */
export async function saveRecipients(
  docId: string,
  recipients: RecipientInput[],
  opts: { signingOrder?: 'parallel' | 'sequential' } = {},
): Promise<SavedRecipient[]> {
  const doc = await prisma.document.findUnique({ where: { id: docId } })
  if (!doc) throw new Error('NOT_FOUND')
  if (doc.status !== DocStatus.draft) throw new Error('409 ALREADY_SIGNED')

  const seenEmails = new Set<string>()
  const rows = recipients.map((r, i) => {
    const name = typeof r.name === 'string' ? r.name.trim() : ''
    const email = typeof r.email === 'string' ? r.email.trim() : ''
    if (!name || !EMAIL_RE.test(email)) throw new Error('INVALID_RECIPIENTS')
    const key = email.toLowerCase()
    if (seenEmails.has(key)) throw new Error('INVALID_RECIPIENTS')
    seenEmails.add(key)
    return {
      id: typeof r.id === 'string' && r.id ? r.id : uid(),
      documentId: docId,
      name,
      email,
      orderIndex: Number.isInteger(r.orderIndex) ? (r.orderIndex as number) : i,
      // A placeholder token so the NOT-NULL/unique column is populated during
      // editing; sendForSignature mints the live signing token at send time.
      token: uid(),
    }
  })

  const signingOrder =
    opts.signingOrder === 'parallel' || opts.signingOrder === 'sequential' ? opts.signingOrder : undefined

  // Replace-all, atomic (see saveFields for the same delete+create rationale).
  await prisma.$transaction([
    prisma.recipient.deleteMany({ where: { documentId: docId } }),
    ...(rows.length ? [prisma.recipient.createMany({ data: rows })] : []),
    ...(signingOrder ? [prisma.document.update({ where: { id: docId }, data: { signingOrder } })] : []),
  ])

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    email: r.email,
    orderIndex: r.orderIndex,
    status: 'pending',
    token: r.token,
  }))
}

/**
 * Transitions a draft document to `sent`: validates there is at least one
 * recipient and that every recipient has at least one field assigned, mints a
 * fresh unguessable signing token per recipient, resets every recipient to
 * `pending`, stamps Document.status='sent' + sentAt, and records a `send`
 * AuditEvent. Returns the per-recipient signing tokens so the caller (route)
 * can build shareable `/sign/<token>` links — no email is sent (Phase 3).
 *
 * Throws:
 *  - Error('NOT_FOUND')             — no such document
 *  - Error('409 ALREADY_SIGNED')    — the document is not a draft
 *  - Error('NO_RECIPIENTS')         — zero recipients
 *  - Error('RECIPIENT_WITHOUT_FIELD') — some recipient has no assigned field
 *
 * Phase 4c — optional expiry: `opts.expiresInDays` (a positive integer) stamps
 * `Document.expiresAt = now + N days`. Once past, the signer `validate()`
 * rejects the document (reason `expired`) so recipients can no longer sign.
 * Omitted/null/invalid → no expiry (the doc never expires).
 */
export async function sendForSignature(
  docId: string,
  actorUserId: string,
  meta: UploadMeta = {},
  opts: { expiresInDays?: number | null } = {},
): Promise<SavedRecipient[]> {
  const doc = await prisma.document.findUnique({
    where: { id: docId },
    include: { recipients: { orderBy: { orderIndex: 'asc' } }, fields: true },
  })
  if (!doc) throw new Error('NOT_FOUND')
  if (doc.status !== DocStatus.draft) throw new Error('409 ALREADY_SIGNED')
  if (doc.recipients.length === 0) throw new Error('NO_RECIPIENTS')

  // Every recipient must have at least one field assigned to them, else there
  // is nothing for them to sign.
  const assigned = new Set(doc.fields.map((f) => f.recipientId).filter((id): id is string => !!id))
  const orphan = doc.recipients.find((r) => !assigned.has(r.id))
  if (orphan) throw new Error('RECIPIENT_WITHOUT_FIELD')

  // Mint a fresh live token per recipient at send time.
  const tokens = new Map(doc.recipients.map((r) => [r.id, uid()]))

  // Optional expiry: only a positive, finite day count sets a deadline; anything
  // else (omitted/null/0/negative/NaN) leaves the document without one.
  const days = opts.expiresInDays == null ? null : Number(opts.expiresInDays)
  const expiresAt =
    days != null && Number.isFinite(days) && days > 0
      ? new Date(Date.now() + Math.floor(days) * 24 * 60 * 60 * 1000)
      : null

  await prisma.$transaction(async (tx) => {
    for (const r of doc.recipients) {
      await tx.recipient.update({
        where: { id: r.id },
        data: {
          token: tokens.get(r.id)!,
          status: 'pending',
          viewedAt: null,
          signedAt: null,
          declinedAt: null,
        },
      })
    }
    await tx.document.update({
      where: { id: docId },
      data: { status: DocStatus.sent, sentAt: new Date(), expiresAt },
    })
    await tx.auditEvent.create({
      data: {
        documentId: docId,
        userId: actorUserId,
        action: AuditAction.send,
        ip: meta.ip ?? null,
        userAgent: meta.userAgent ?? null,
        detail: { recipientCount: doc.recipients.length } as Prisma.InputJsonValue,
      },
    })
  })

  // Best-effort notifications (Phase 3): email recipients their signing link
  // (all for parallel; only the first for sequential). Wrapped so an SMTP/mail
  // failure can never break the send that already committed above.
  try {
    await notifyOnSend(docId, meta.baseUrl)
  } catch (err) {
    console.error('[sendForSignature] notify failed:', err instanceof Error ? err.message : String(err))
  }

  // Best-effort webhook: `document.sent`. Never affects the committed send.
  try {
    await emitDocumentSent(docId)
  } catch (err) {
    console.error('[sendForSignature] webhook failed:', err instanceof Error ? err.message : String(err))
  }

  return doc.recipients.map((r) => ({
    id: r.id,
    name: r.name,
    email: r.email,
    orderIndex: r.orderIndex,
    status: 'pending',
    token: tokens.get(r.id)!,
  }))
}
