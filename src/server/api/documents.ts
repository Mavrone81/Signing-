import type { Document, Recipient } from '@prisma/client'
import { prisma } from '@/lib/db'

// Document load for the public API — the single choke point for `/api/v1`
// document access. A key acts as the user who created it, so it gets exactly
// that user's in-app access (owner-only, see canAccessDocument): documents in
// the key's org that its creator uploaded. Anything else resolves to `null`
// (the route maps that to 404), so a key can never observe another tenant's
// document — or a colleague's, which would otherwise let an org admin mint a
// key to get around the owner-only rule.
export async function loadOrgDocument(
  ctx: { orgId: string; actorUserId: string },
  id: string,
): Promise<Document | null> {
  if (!id || typeof id !== 'string') return null
  const doc = await prisma.document.findUnique({ where: { id } })
  if (!doc || doc.orgId !== ctx.orgId || doc.ownerId !== ctx.actorUserId) return null
  return doc
}

// Public JSON shape for a recipient (never exposes the signing token). Accepts a
// structural shape so both Prisma rows and the `SavedRecipient` (status: string)
// returned by saveRecipients serialize through the same path.
export function serializeRecipient(r: {
  id: string
  name: string
  email: string
  status: string
  orderIndex: number
}) {
  return {
    id: r.id,
    name: r.name,
    email: r.email,
    status: r.status,
    orderIndex: r.orderIndex,
  }
}

// Public JSON shape for a document (no storage keys, no hashes beyond what's
// safe to expose). Recipients included when loaded.
export function serializeDocument(
  doc: Pick<
    Document,
    'id' | 'originalName' | 'status' | 'pageCount' | 'signingOrder' | 'createdAt' | 'sentAt' | 'signedAt' | 'expiresAt'
  >,
  recipients?: Pick<Recipient, 'id' | 'name' | 'email' | 'status' | 'orderIndex'>[],
) {
  return {
    id: doc.id,
    name: doc.originalName,
    status: doc.status,
    pageCount: doc.pageCount,
    signingOrder: doc.signingOrder,
    createdAt: doc.createdAt,
    sentAt: doc.sentAt,
    signedAt: doc.signedAt,
    expiresAt: doc.expiresAt,
    ...(recipients ? { recipients: recipients.map(serializeRecipient) } : {}),
  }
}
