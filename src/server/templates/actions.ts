import { AuditAction, DocStatus, FieldType, Prisma } from '@prisma/client'
import { uid } from '@/lib/uid'
import { prisma } from '@/lib/db'
import { putObject, getObject, deleteObject } from '@/lib/storage'
import { sha256hex } from '@/lib/hash'
import { canAccessDocument } from '@/lib/rbac'

// The acting user, as seen by every template action. Mirrors the shape passed
// to canAccessDocument so org-gating stays identical to the document routes.
export interface TemplateActor {
  id: string
  orgId: string | null
  orgRole: 'owner' | 'admin' | 'member' | null
}

// Copy a Field/TemplateField's geometry + config, preserving the type-specific
// style/options handling (text carries a style; dropdown/radio carry options;
// everything else stores SQL NULL). Shared by save-as (Field→TemplateField) and
// new-from (TemplateField→Field) so the two directions can never diverge.
function jsonOrNull(v: Prisma.JsonValue | null): Prisma.InputJsonValue | typeof Prisma.DbNull {
  return v === null || v === undefined ? Prisma.DbNull : (v as Prisma.InputJsonValue)
}

/**
 * Saves a source Document's layout as a reusable Template (Phase 4b). Copies the
 * document's PDF into a NEW encrypted blob (never shared with the document), then
 * mirrors its Field rows → TemplateField and Recipient rows → TemplateRole, tying
 * fields to roles through a stable per-recipient `roleKey` (self fields → null).
 *
 * Org-gated: the caller must be able to access the source document (same org, and
 * owner/admin or the doc's owner). Any-status document may be templated.
 *
 * Throws:
 *  - Error('NOT_FOUND')     — no such document
 *  - Error('FORBIDDEN')     — the actor can't access the source document
 *  - Error('INVALID_NAME')  — empty template name
 */
export async function saveAsTemplate(
  documentId: string,
  name: string,
  description: string | null,
  actor: TemplateActor,
): Promise<{ id: string; name: string }> {
  const doc = await prisma.document.findUnique({
    where: { id: documentId },
    include: { fields: true, recipients: { orderBy: { orderIndex: 'asc' } } },
  })
  if (!doc) throw new Error('NOT_FOUND')
  if (!canAccessDocument(actor, { ownerId: doc.ownerId, orgId: doc.orgId })) {
    throw new Error('FORBIDDEN')
  }

  const cleanName = typeof name === 'string' ? name.trim() : ''
  if (!cleanName) throw new Error('INVALID_NAME')
  const cleanDescription =
    typeof description === 'string' && description.trim() ? description.trim() : null

  // A stable roleKey per recipient so fields can be re-wired onto the matching
  // recipient when a document is later created from this template.
  const roleKeyByRecipient = new Map(doc.recipients.map((r) => [r.id, uid()]))

  // COPY the PDF into the template's OWN encrypted blob (decrypt-then-re-encrypt
  // via get/putObject) BEFORE any DB write, so a failure here never leaves a
  // Template pointing at content that was never written. Never share the doc's
  // storageKey — deleting the doc must not orphan the template's PDF.
  const templateId = uid()
  const storageKey = `templates/${templateId}/original.pdf`
  const bytes = await getObject(doc.originalKey)
  await putObject(storageKey, bytes)

  await prisma.$transaction(async (tx) => {
    await tx.template.create({
      data: {
        id: templateId,
        orgId: doc.orgId,
        name: cleanName,
        description: cleanDescription,
        storageKey,
        pageCount: doc.pageCount,
        createdById: actor.id,
      },
    })

    if (doc.recipients.length) {
      await tx.templateRole.createMany({
        data: doc.recipients.map((r) => ({
          templateId,
          name: r.name,
          orderIndex: r.orderIndex,
          roleKey: roleKeyByRecipient.get(r.id)!,
        })),
      })
    }

    if (doc.fields.length) {
      await tx.templateField.createMany({
        data: doc.fields.map((f) => ({
          templateId,
          page: f.page,
          type: f.type,
          x: f.x,
          y: f.y,
          w: f.w,
          h: f.h,
          value: f.value,
          style: jsonOrNull(f.style),
          required: f.required,
          options: jsonOrNull(f.options),
          // Self field (recipientId null) → roleKey null; assigned field →
          // the recipient's stable roleKey.
          roleKey: f.recipientId ? (roleKeyByRecipient.get(f.recipientId) ?? null) : null,
        })),
      })
    }
  })

  return { id: templateId, name: cleanName }
}

/**
 * Creates a new draft Document from a Template (Phase 4b). Copies the template's
 * PDF into a NEW document blob (re-encrypted, distinct from the template's blob),
 * then mirrors TemplateField → Field and TemplateRole → Recipient, remapping each
 * role's `roleKey` to the freshly-created recipient id so every field lands on the
 * right recipient. Recipient emails are left BLANK for the sender to fill in the
 * editor before sending. A template with no roles yields a self-sign draft.
 *
 * Org-gated: any MEMBER of the template's org may use it (a template is org-wide
 * shared tenant data — unlike a document, it is not owner-scoped).
 *
 * Throws:
 *  - Error('NOT_FOUND') — no such template, or it belongs to another org
 */
export async function createDocumentFromTemplate(
  templateId: string,
  actor: TemplateActor,
): Promise<{ documentId: string }> {
  const template = await prisma.template.findUnique({
    where: { id: templateId },
    include: {
      templateFields: true,
      templateRoles: { orderBy: { orderIndex: 'asc' } },
    },
  })
  // 404 (not 403) for a template outside the actor's org — don't leak existence.
  if (!template || !actor.orgId || template.orgId !== actor.orgId) {
    throw new Error('NOT_FOUND')
  }

  const documentId = uid()
  const originalKey = `${documentId}/original.pdf`
  // COPY the template PDF into the document's OWN encrypted blob before any DB
  // write (see saveAsTemplate for the fail-closed ordering). Distinct key ⇒ the
  // document and template never share bytes.
  const bytes = await getObject(template.storageKey)
  const originalSha256 = sha256hex(bytes)
  await putObject(originalKey, bytes)

  // Pre-mint a recipient id per role so fields can reference it inside the same
  // transaction, and remap roleKey → new recipient id for field wiring.
  const roleRows = template.templateRoles.map((role) => ({
    id: uid(),
    roleKey: role.roleKey,
    name: role.name,
    orderIndex: role.orderIndex,
  }))
  const recipientIdByRoleKey = new Map(roleRows.map((r) => [r.roleKey, r.id]))

  await prisma.$transaction(async (tx) => {
    await tx.document.create({
      data: {
        id: documentId,
        ownerId: actor.id,
        orgId: template.orgId,
        originalName: template.name,
        status: DocStatus.draft,
        originalKey,
        originalSha256,
        pageCount: template.pageCount,
      },
    })

    if (roleRows.length) {
      await tx.recipient.createMany({
        data: roleRows.map((r) => ({
          id: r.id,
          documentId,
          // Blank for the sender to fill in the editor before sending.
          email: '',
          name: r.name,
          orderIndex: r.orderIndex,
          // Placeholder token until the doc is actually sent (mirrors saveRecipients).
          token: uid(),
        })),
      })
    }

    if (template.templateFields.length) {
      await tx.field.createMany({
        data: template.templateFields.map((f) => ({
          documentId,
          page: f.page,
          type: f.type as FieldType,
          x: f.x,
          y: f.y,
          w: f.w,
          h: f.h,
          value: f.value,
          style: jsonOrNull(f.style),
          required: f.required,
          options: jsonOrNull(f.options),
          assigneeId: null,
          // Re-wire onto the matching recipient; null roleKey → self field.
          recipientId: f.roleKey ? (recipientIdByRoleKey.get(f.roleKey) ?? null) : null,
        })),
      })
    }

    await tx.auditEvent.create({
      data: {
        documentId,
        userId: actor.id,
        action: AuditAction.upload,
        detail: { fromTemplateId: template.id } as Prisma.InputJsonValue,
      },
    })
  })

  return { documentId }
}

/**
 * Lists the templates visible to the actor — every template in their org
 * (templates are org-wide shared, not owner-scoped), newest first. An actor with
 * no org sees nothing.
 */
export async function listTemplates(actor: TemplateActor) {
  if (!actor.orgId) return []
  return prisma.template.findMany({
    where: { orgId: actor.orgId },
    orderBy: { createdAt: 'desc' },
    include: { _count: { select: { templateFields: true, templateRoles: true } } },
  })
}

/**
 * Deletes a template (and cascades its fields/roles) plus its encrypted PDF blob.
 * Org-gated + authz: only the template's creator OR an org owner/admin may delete
 * it; a plain member who did not create it cannot.
 *
 * Throws:
 *  - Error('NOT_FOUND') — no such template, or it belongs to another org
 *  - Error('FORBIDDEN') — same-org member who is neither creator nor owner/admin
 */
export async function deleteTemplate(templateId: string, actor: TemplateActor): Promise<void> {
  const template = await prisma.template.findUnique({ where: { id: templateId } })
  // 404 for a missing template or one outside the actor's org (don't leak).
  if (!template || !actor.orgId || template.orgId !== actor.orgId) {
    throw new Error('NOT_FOUND')
  }
  const isOrgAdmin = actor.orgRole === 'owner' || actor.orgRole === 'admin'
  if (!isOrgAdmin && template.createdById !== actor.id) {
    throw new Error('FORBIDDEN')
  }

  // Remove the encrypted blob first (tolerant of a missing file), then the row —
  // cascade drops its TemplateField/TemplateRole children.
  await deleteObject(template.storageKey)
  await prisma.template.delete({ where: { id: templateId } })
}
