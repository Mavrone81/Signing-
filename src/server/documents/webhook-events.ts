// Server-only webhook event emitters for the signing flow. Each function loads
// the minimal document context and dispatches a signed webhook via
// src/lib/webhooks.ts. EVERY function here is BEST-EFFORT and NEVER THROWS: a DB
// or delivery failure must not break send / view / sign / complete / decline
// (same contract as src/server/documents/notify.ts). Payloads carry only public
// document + recipient metadata — never secrets, tokens, or raw PDF bytes.
import { prisma } from '@/lib/db'
import { dispatchEvent, type WebhookEvent } from '@/lib/webhooks'

// Shape shared across events: the document + its recipients (public fields only).
async function loadContext(documentId: string) {
  return prisma.document.findUnique({
    where: { id: documentId },
    select: {
      id: true,
      orgId: true,
      originalName: true,
      status: true,
      recipients: {
        orderBy: { orderIndex: 'asc' },
        select: { id: true, name: true, email: true, status: true, orderIndex: true },
      },
    },
  })
}

type LoadedContext = NonNullable<Awaited<ReturnType<typeof loadContext>>>

function documentData(doc: LoadedContext) {
  return {
    id: doc.id,
    name: doc.originalName,
    status: doc.status,
  }
}

function recipientsData(doc: LoadedContext) {
  return doc.recipients.map((r) => ({
    id: r.id,
    name: r.name,
    email: r.email,
    status: r.status,
    orderIndex: r.orderIndex,
  }))
}

// Load + dispatch, fully guarded. `recipientId` (when given) adds a single
// `recipient` object to the payload for recipient-scoped events.
async function emit(documentId: string, event: WebhookEvent, recipientId?: string): Promise<void> {
  try {
    const doc = await loadContext(documentId)
    if (!doc) return
    const recipient = recipientId ? doc.recipients.find((r) => r.id === recipientId) : undefined
    await dispatchEvent(doc.orgId, event, {
      document: documentData(doc),
      recipients: recipientsData(doc),
      ...(recipient
        ? {
            recipient: {
              id: recipient.id,
              name: recipient.name,
              email: recipient.email,
              status: recipient.status,
              orderIndex: recipient.orderIndex,
            },
          }
        : {}),
    })
  } catch (err) {
    console.error(`[webhook-events] ${event} emit failed:`, err instanceof Error ? err.message : String(err))
  }
}

export const emitDocumentSent = (documentId: string) => emit(documentId, 'document.sent')
export const emitRecipientViewed = (documentId: string, recipientId: string) =>
  emit(documentId, 'recipient.viewed', recipientId)
export const emitRecipientSigned = (documentId: string, recipientId: string) =>
  emit(documentId, 'recipient.signed', recipientId)
export const emitDocumentCompleted = (documentId: string) => emit(documentId, 'document.completed')
export const emitDocumentDeclined = (documentId: string, recipientId: string) =>
  emit(documentId, 'document.declined', recipientId)
