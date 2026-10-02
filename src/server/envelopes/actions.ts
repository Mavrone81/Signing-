// Server-only core of ENVELOPES: several documents sent to the same people
// together, with ONE invitation and ONE link per signer. Kept free of Next
// request/redirect context so it is directly testable (the form layer lives in
// src/app/(app)/envelopes/actions.ts).
//
// An envelope is a THIN coordination layer. Each document keeps its own
// recipients, fields, finalize and signed file, and goes through the unchanged
// per-document send and signing flows; the envelope only groups them. Its
// status is derived from its documents (src/lib/envelopes.ts), never stored.
//
// Access is owner-only, exactly like documents (see src/lib/rbac.ts): only the
// person who created an envelope, in its own org, can see or change it, and it
// can only hold that person's own documents from that org.
import { DocStatus, RecipientStatus, type OrgRole } from '@prisma/client'
import { prisma } from '@/lib/db'
import { uid } from '@/lib/uid'
import { canAccessDocument } from '@/lib/rbac'
import { deriveEnvelopeStatus, normalizeSigners, type EnvelopeStatus, type SignerInput } from '@/lib/envelopes'
import { normalizeInviteMessage } from '@/lib/invite-message'
import { sendForSignature, type UploadMeta } from '@/server/documents/actions'
import { sendEmail } from '@/lib/mailer'
import { renderEnvelopeEmail, type EmailBrand } from '@/lib/email-templates'
import { resolveBrand } from '@/lib/branding'

export type EnvelopeActor = { id: string; orgId: string | null; orgRole: OrgRole | null }

type Owned = { ownerId: string; orgId: string }
const canAccessEnvelope = (actor: EnvelopeActor, env: Owned) => canAccessDocument(actor, env)

async function loadOwnedEnvelope(actor: EnvelopeActor, envelopeId: string) {
  if (!envelopeId || typeof envelopeId !== 'string') return null
  const env = await prisma.envelope.findUnique({ where: { id: envelopeId } })
  return env && canAccessEnvelope(actor, env) ? env : null
}

// Documents the actor may put in an envelope: their own drafts in their org
// that aren't already in one.
async function attachableDocuments(actor: EnvelopeActor, ids: string[]) {
  if (!actor.orgId || ids.length === 0) return []
  return prisma.document.findMany({
    where: { id: { in: ids }, ownerId: actor.id, orgId: actor.orgId, status: DocStatus.draft, envelopeId: null },
    select: { id: true },
  })
}

// --- Create / edit ---------------------------------------------------------

export type CreateEnvelopeResult =
  | { ok: true; id: string }
  | { ok: false; error: 'NO_ORGANIZATION' | 'INVALID' | 'NOT_FOUND' }

/**
 * Create an envelope from some of the actor's own draft documents. Every id
 * must be attachable (own, same org, draft, not already in an envelope) or
 * nothing is created (NOT_FOUND — never a hint that someone else's id exists).
 */
export async function createEnvelope(
  actor: EnvelopeActor,
  input: { name: string; documentIds: string[] },
): Promise<CreateEnvelopeResult> {
  if (!actor.orgId) return { ok: false, error: 'NO_ORGANIZATION' }
  const name = (input.name ?? '').trim().slice(0, 200)
  const ids = [...new Set(input.documentIds ?? [])]
  if (!name) return { ok: false, error: 'INVALID' }
  const docs = await attachableDocuments(actor, ids)
  if (docs.length !== ids.length) return { ok: false, error: 'NOT_FOUND' }

  const env = await prisma.$transaction(async (tx) => {
    const e = await tx.envelope.create({ data: { orgId: actor.orgId!, ownerId: actor.id, name } })
    if (ids.length) await tx.document.updateMany({ where: { id: { in: ids } }, data: { envelopeId: e.id } })
    return e
  })
  return { ok: true, id: env.id }
}

export async function addDocuments(
  actor: EnvelopeActor,
  envelopeId: string,
  documentIds: string[],
): Promise<{ ok: true; added: number } | { ok: false; error: 'NOT_FOUND' }> {
  const env = await loadOwnedEnvelope(actor, envelopeId)
  if (!env) return { ok: false, error: 'NOT_FOUND' }
  const ids = [...new Set(documentIds ?? [])]
  const docs = await attachableDocuments(actor, ids)
  if (docs.length !== ids.length) return { ok: false, error: 'NOT_FOUND' }
  if (ids.length) await prisma.document.updateMany({ where: { id: { in: ids } }, data: { envelopeId: env.id } })
  // New documents get the envelope's current signers.
  const signers = await prisma.envelopeSigner.findMany({ where: { envelopeId: env.id }, orderBy: { orderIndex: 'asc' } })
  if (signers.length) {
    for (const id of ids) await syncRecipients(id, signers)
  }
  return { ok: true, added: ids.length }
}

// Take a DRAFT document out of the envelope (the document itself is untouched).
export async function removeDocument(
  actor: EnvelopeActor,
  envelopeId: string,
  documentId: string,
): Promise<{ ok: true } | { ok: false; error: 'NOT_FOUND' | 'NOT_DRAFT' }> {
  const env = await loadOwnedEnvelope(actor, envelopeId)
  if (!env) return { ok: false, error: 'NOT_FOUND' }
  const doc = await prisma.document.findFirst({ where: { id: documentId, envelopeId: env.id }, select: { status: true } })
  if (!doc) return { ok: false, error: 'NOT_FOUND' }
  if (doc.status !== DocStatus.draft) return { ok: false, error: 'NOT_DRAFT' }
  await prisma.document.update({ where: { id: documentId }, data: { envelopeId: null } })
  return { ok: true }
}

// --- Signers ---------------------------------------------------------------

// Make one draft document's recipients match the signer list: recipients whose
// email is still listed are kept (so their placed fields stay assigned) and
// renamed/reordered; new signers are added; anyone no longer listed is removed,
// which UNASSIGNS their fields (Field.recipientId → null) rather than deleting
// the placement. Returns how many fields were unassigned.
async function syncRecipients(documentId: string, signers: { name: string; email: string }[]): Promise<number> {
  return prisma.$transaction(async (tx) => {
    const existing = await tx.recipient.findMany({ where: { documentId } })
    const wanted = new Map(signers.map((s, i) => [s.email.toLowerCase(), { ...s, orderIndex: i }]))
    const gone = existing.filter((r) => !wanted.has(r.email.toLowerCase()))
    const unassigned = gone.length
      ? await tx.field.count({ where: { documentId, recipientId: { in: gone.map((r) => r.id) } } })
      : 0
    if (gone.length) await tx.recipient.deleteMany({ where: { id: { in: gone.map((r) => r.id) } } })
    const kept = new Map(existing.filter((r) => wanted.has(r.email.toLowerCase())).map((r) => [r.email.toLowerCase(), r]))
    for (const [email, s] of wanted) {
      const r = kept.get(email)
      if (r) await tx.recipient.update({ where: { id: r.id }, data: { name: s.name, orderIndex: s.orderIndex } })
      else await tx.recipient.create({ data: { documentId, email, name: s.name, orderIndex: s.orderIndex, token: uid() } })
    }
    return unassigned
  })
}

export type SetSignersResult =
  | {
      ok: true
      // Documents where placed fields lost their signer (they now need re-assigning).
      unassigned: { documentId: string; name: string; fields: number }[]
      // Documents already sent, which keep their own recipients.
      skipped: { documentId: string; name: string }[]
    }
  | { ok: false; error: 'NOT_FOUND' | 'INVALID' }

/**
 * Set the envelope's signers. This REPLACES the recipients of every DRAFT
 * document in it with the same list (see syncRecipients); already-sent
 * documents are left alone and reported. A signer whose email is unchanged
 * keeps their link, so a link already shared keeps working.
 */
export async function setSigners(
  actor: EnvelopeActor,
  envelopeId: string,
  rows: SignerInput[],
): Promise<SetSignersResult> {
  const env = await loadOwnedEnvelope(actor, envelopeId)
  if (!env) return { ok: false, error: 'NOT_FOUND' }
  const signers = normalizeSigners(rows)
  if (!signers) return { ok: false, error: 'INVALID' }

  await prisma.$transaction(async (tx) => {
    const current = await tx.envelopeSigner.findMany({ where: { envelopeId: env.id } })
    const byEmail = new Map(current.map((s) => [s.email, s]))
    const keep = new Set(signers.map((s) => s.email))
    await tx.envelopeSigner.deleteMany({ where: { envelopeId: env.id, email: { notIn: [...keep] } } })
    for (const [i, s] of signers.entries()) {
      const had = byEmail.get(s.email)
      if (had) await tx.envelopeSigner.update({ where: { id: had.id }, data: { name: s.name, orderIndex: i } })
      else await tx.envelopeSigner.create({ data: { envelopeId: env.id, email: s.email, name: s.name, orderIndex: i, token: uid() } })
    }
  })

  const docs = await prisma.document.findMany({
    where: { envelopeId: env.id },
    select: { id: true, originalName: true, status: true },
    orderBy: { createdAt: 'asc' },
  })
  const unassigned: { documentId: string; name: string; fields: number }[] = []
  const skipped: { documentId: string; name: string }[] = []
  for (const d of docs) {
    if (d.status !== DocStatus.draft) {
      skipped.push({ documentId: d.id, name: d.originalName })
      continue
    }
    const n = await syncRecipients(d.id, signers)
    if (n > 0) unassigned.push({ documentId: d.id, name: d.originalName, fields: n })
  }
  return { ok: true, unassigned, skipped }
}

// --- View ------------------------------------------------------------------

export type EnvelopeDocumentView = {
  id: string
  name: string
  status: DocStatus
  recipientCount: number
  // Why a draft can't go out yet (null = ready, or already sent).
  notReady: 'NO_RECIPIENTS' | 'RECIPIENT_WITHOUT_FIELD' | null
}

export type EnvelopeView = {
  id: string
  name: string
  status: EnvelopeStatus
  inviteMessage: string | null
  documents: EnvelopeDocumentView[]
  signers: { id: string; name: string; email: string; token: string }[]
  createdAt: Date
}

function readiness(doc: { recipients: { id: string }[]; fields: { recipientId: string | null }[] }): EnvelopeDocumentView['notReady'] {
  if (doc.recipients.length === 0) return 'NO_RECIPIENTS'
  const assigned = new Set(doc.fields.map((f) => f.recipientId).filter(Boolean))
  return doc.recipients.every((r) => assigned.has(r.id)) ? null : 'RECIPIENT_WITHOUT_FIELD'
}

export async function getEnvelope(actor: EnvelopeActor, envelopeId: string): Promise<EnvelopeView | null> {
  const env = await loadOwnedEnvelope(actor, envelopeId)
  if (!env) return null
  const [docs, signers] = await Promise.all([
    prisma.document.findMany({
      where: { envelopeId: env.id },
      orderBy: { createdAt: 'asc' },
      include: { recipients: { select: { id: true } }, fields: { select: { recipientId: true } } },
    }),
    prisma.envelopeSigner.findMany({ where: { envelopeId: env.id }, orderBy: { orderIndex: 'asc' } }),
  ])
  return {
    id: env.id,
    name: env.name,
    status: deriveEnvelopeStatus(docs.map((d) => d.status)),
    inviteMessage: env.inviteMessage,
    documents: docs.map((d) => ({
      id: d.id,
      name: d.originalName,
      status: d.status,
      recipientCount: d.recipients.length,
      notReady: d.status === DocStatus.draft ? readiness(d) : null,
    })),
    signers: signers.map((s) => ({ id: s.id, name: s.name, email: s.email, token: s.token })),
    createdAt: env.createdAt,
  }
}

export async function listEnvelopes(actor: EnvelopeActor) {
  if (!actor.orgId) return []
  const rows = await prisma.envelope.findMany({
    where: { orgId: actor.orgId, ownerId: actor.id },
    orderBy: { createdAt: 'desc' },
    include: { documents: { select: { status: true } }, _count: { select: { signers: true } } },
  })
  return rows.map((e) => ({
    id: e.id,
    name: e.name,
    status: deriveEnvelopeStatus(e.documents.map((d) => d.status)),
    documentCount: e.documents.length,
    signerCount: e._count.signers,
    createdAt: e.createdAt,
  }))
}

// --- Send ------------------------------------------------------------------

export type SendEnvelopeResult =
  | {
      ok: true
      sent: { documentId: string; name: string }[]
      skipped: { documentId: string; name: string; reason: string }[]
      emailed: { email: string; sent: boolean }[]
    }
  | { ok: false; error: 'NOT_FOUND' | 'NO_SIGNERS' }

/**
 * Send every READY draft in the envelope, skip (and report) any that isn't —
 * one unready document never blocks the rest — then email each signer ONCE,
 * listing the documents that went out to them, with their single link. Each
 * document is sent through the normal per-document path (tokens, audit,
 * webhooks), just without its own invitation email. An email is audited as a
 * `notify` event on every document it covered.
 */
export async function sendEnvelope(
  actor: EnvelopeActor,
  envelopeId: string,
  opts: { message?: unknown; meta?: UploadMeta } = {},
): Promise<SendEnvelopeResult> {
  const env = await loadOwnedEnvelope(actor, envelopeId)
  if (!env) return { ok: false, error: 'NOT_FOUND' }
  const signers = await prisma.envelopeSigner.findMany({ where: { envelopeId: env.id }, orderBy: { orderIndex: 'asc' } })
  if (signers.length === 0) return { ok: false, error: 'NO_SIGNERS' }

  const message = opts.message === undefined ? env.inviteMessage : normalizeInviteMessage(opts.message)
  await prisma.envelope.update({ where: { id: env.id }, data: { inviteMessage: message } })

  const docs = await prisma.document.findMany({
    where: { envelopeId: env.id, status: DocStatus.draft },
    orderBy: { createdAt: 'asc' },
    include: { recipients: { select: { id: true, email: true } }, fields: { select: { recipientId: true } } },
  })

  const sent: { documentId: string; name: string; emails: Set<string> }[] = []
  const skipped: { documentId: string; name: string; reason: string }[] = []
  for (const d of docs) {
    const notReady = readiness(d)
    if (notReady) {
      skipped.push({ documentId: d.id, name: d.originalName, reason: notReady })
      continue
    }
    try {
      await sendForSignature(d.id, actor.id, opts.meta ?? {}, { message: message ?? '', notify: false })
      sent.push({ documentId: d.id, name: d.originalName, emails: new Set(d.recipients.map((r) => r.email.toLowerCase())) })
    } catch (err) {
      skipped.push({ documentId: d.id, name: d.originalName, reason: err instanceof Error ? err.message : 'SEND_FAILED' })
    }
  }

  const emailed: { email: string; sent: boolean }[] = []
  if (sent.length) {
    const [sender, org] = await Promise.all([
      prisma.user.findUnique({ where: { id: actor.id }, select: { name: true } }),
      prisma.organization.findUnique({
        where: { id: env.orgId },
        select: { name: true, brandName: true, brandColor: true, logoKey: true },
      }),
    ])
    const resolved = org ? resolveBrand(org) : null
    const brand: EmailBrand | undefined = resolved?.customized ? { name: resolved.name, color: resolved.color } : undefined
    const base = (opts.meta?.baseUrl ?? '').replace(/\/+$/, '')

    for (const s of signers) {
      const theirs = sent.filter((d) => d.emails.has(s.email))
      if (theirs.length === 0) continue
      const rendered = renderEnvelopeEmail({
        recipientName: s.name,
        senderName: sender?.name ?? 'A sender',
        envelopeName: env.name,
        docNames: theirs.map((d) => d.name),
        envelopeUrl: `${base}/e/${s.token}`,
        message,
        brand,
      })
      const result = await sendEmail({ orgId: env.orgId, to: s.email, ...rendered })
      emailed.push({ email: s.email, sent: result.sent })
      await prisma.auditEvent.createMany({
        data: theirs.map((d) => ({
          documentId: d.documentId,
          userId: null,
          action: 'notify' as const,
          detail: {
            kind: 'envelope',
            envelopeId: env.id,
            to: s.email,
            sent: result.sent,
            ...(result.via ? { via: result.via } : {}),
            ...(result.sent ? {} : { reason: result.reason }),
          },
        })),
      })
    }
  }

  return {
    ok: true,
    sent: sent.map(({ documentId, name }) => ({ documentId, name })),
    skipped,
    emailed,
  }
}

// --- Signer's single link (/e/<token>) — UNAUTHENTICATED ------------------

export type SignerEnvelopeView = {
  envelopeName: string
  senderName: string
  signerName: string
  documents: {
    name: string
    // The per-document signing link token; null until that document is sent.
    signToken: string | null
    recipientStatus: RecipientStatus | null
    documentStatus: DocStatus
  }[]
}

/**
 * What a signer sees at /e/<token>: the documents in the envelope that they are
 * a recipient of. The token IS the authorization (unguessable, per signer), so
 * it only ever reveals that signer's own per-document links — each of which
 * then goes through the unchanged /sign/<token> flow and its own checks
 * (turn order, expiry, already signed). Unsent drafts are not shown.
 */
export async function getSignerEnvelope(token: string): Promise<SignerEnvelopeView | null> {
  if (!token || typeof token !== 'string') return null
  const signer = await prisma.envelopeSigner.findUnique({
    where: { token },
    include: { envelope: { include: { owner: { select: { name: true } } } } },
  })
  if (!signer) return null
  const docs = await prisma.document.findMany({
    where: { envelopeId: signer.envelopeId, status: { not: DocStatus.draft } },
    orderBy: { createdAt: 'asc' },
    include: { recipients: { where: { email: signer.email }, select: { token: true, status: true } } },
  })
  return {
    envelopeName: signer.envelope.name,
    senderName: signer.envelope.owner.name,
    signerName: signer.name,
    documents: docs
      .filter((d) => d.recipients.length > 0)
      .map((d) => ({
        name: d.originalName,
        signToken: d.recipients[0].token,
        recipientStatus: d.recipients[0].status,
        documentStatus: d.status,
      })),
  }
}
