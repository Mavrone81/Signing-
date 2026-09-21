'use client'

import dynamic from 'next/dynamic'
import Link from 'next/link'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { PageHeader } from '@/components/ui/PageHeader'
import { StatusPill } from '@/components/ui/StatusPill'
import { buttonClasses } from '@/components/ui/Button'
import { FieldLayer } from './FieldLayer'
import { FieldToolbar } from './FieldToolbar'
import { TextFormatPanel } from './TextFormatPanel'
import { FieldConfigPanel } from './FieldConfigPanel'
import { RecipientsPanel } from './RecipientsPanel'
import { DEFAULT_INVITE_MESSAGE, MAX_INVITE_MESSAGE } from '@/lib/invite-message'
import { SignatureModal } from './SignatureModal'
import { uid } from '@/lib/uid'
import { clampFieldRect } from '@/lib/coords'
import {
  DEFAULT_TEXT_STYLE,
  isFieldFilled,
  recipientColor,
  type EditorField,
  type EditorRecipient,
  type FieldOptions,
  type FieldType,
  type FlatField,
  type SigningOrder,
  type TextStyle,
} from './types'

// A recipient as the sender sees it: the editable identity plus (once sent) a
// live status + shareable signing link for the status view.
export interface SenderRecipient {
  id: string
  name: string
  email: string
  status: string
  signingUrl: string | null
}

// Pre-existing latent bug fixed in passing (found while getting Task 13's
// e2e to actually run against a real `next start` + real Chromium, not
// jsdom): Viewer.tsx imports pdfjs-dist at module scope, and pdfjs-dist's
// default (browser) build touches DOM-only globals (e.g. `DOMMatrix`) as
// soon as it's evaluated — which crashes with a server-side
// `ReferenceError: DOMMatrix is not defined` the instant Next tries to SSR
// it. `ssr: false` keeps Viewer's module out of the server render path
// entirely, so `/documents/[id]/edit` no longer 500s on a cold/direct load.
const Viewer = dynamic(() => import('./Viewer').then((m) => m.Viewer), { ssr: false })

interface EditorProps {
  documentId: string
  originalName: string
  status: string
  initialFields: FlatField[]
  initialRecipients: SenderRecipient[]
  initialSigningOrder: SigningOrder
  // The note used last time this document was sent (null = none/never sent).
  initialInviteMessage?: string | null
  // The envelope this document belongs to, if any — the back link returns there.
  envelopeId?: string | null
}

const SENT_STATUSES = new Set(['sent', 'completed', 'declined'])

const RECIPIENT_STATUS_LABEL: Record<string, string> = {
  pending: 'Pending',
  viewed: 'Viewed',
  signed: 'Signed',
  declined: 'Declined',
}

// Default box size (normalized) per field type when first dropped onto a page.
const DEFAULTS: Record<FieldType, { w: number; h: number }> = {
  signature: { w: 0.25, h: 0.08 },
  initials: { w: 0.12, h: 0.06 },
  date: { w: 0.18, h: 0.05 },
  text: { w: 0.25, h: 0.05 },
  checkbox: { w: 0.035, h: 0.028 },
  radio: { w: 0.035, h: 0.028 },
  dropdown: { w: 0.22, h: 0.05 },
}

// Default per-field config for the option-bearing types.
function defaultOptions(type: FieldType): FieldOptions | undefined {
  if (type === 'dropdown') return { choices: ['Option 1', 'Option 2'] }
  if (type === 'radio') return { group: 'group-1', label: 'Option' }
  return undefined
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10)
}

type SaveState =
  | { phase: 'idle' }
  | { phase: 'busy' }
  | { phase: 'error'; message: string }
  | { phase: 'ok'; message: string }

// Client orchestrator for the edit page: fetches the original PDF, holds the
// field list, and wires Viewer + FieldLayer + FieldToolbar + Save/Finalize.
export function Editor({
  documentId,
  originalName,
  status,
  initialFields,
  initialRecipients,
  initialSigningOrder,
  initialInviteMessage = null,
  envelopeId = null,
}: EditorProps) {
  const [data, setData] = useState<ArrayBuffer | null>(null)
  // The document's current file name (changes when the PDF is replaced) and a
  // counter that re-fetches the PDF after a replace.
  const [docName, setDocName] = useState(originalName)
  const [fileVersion, setFileVersion] = useState(0)
  const replaceInput = useRef<HTMLInputElement | null>(null)
  // The invitation note, PRE-FILLED (with last time's note, else the default) so
  // the sender edits it rather than writing one from nothing.
  const [inviteMessage, setInviteMessage] = useState<string>(initialInviteMessage ?? DEFAULT_INVITE_MESSAGE)
  const [loadError, setLoadError] = useState<string | null>(null)
  // Fields keep their persisted recipientId (assignment) across the client id
  // remap — the recipient id is the stable DB id, so assignments survive reload.
  const [fields, setFields] = useState<EditorField[]>(() =>
    initialFields.map((f) => ({ ...f, id: uid() })),
  )
  const [recipients, setRecipients] = useState<EditorRecipient[]>(() =>
    initialRecipients.map((r) => ({ id: r.id, name: r.name, email: r.email })),
  )
  const [signingOrder, setSigningOrder] = useState<SigningOrder>(initialSigningOrder)
  // Optional expiry (Phase 4c): the number of days from send until the document
  // can no longer be signed. Empty string = no expiry (the default).
  const [expiresInDays, setExpiresInDays] = useState<string>('')
  // Once a document is sent, the sender sees a read-only status view built from
  // these rows (recipient + status + shareable signing link).
  const [sentRecipients, setSentRecipients] = useState<SenderRecipient[]>(() =>
    SENT_STATUSES.has(status) ? initialRecipients : [],
  )
  const [isSent, setIsSent] = useState(SENT_STATUSES.has(status))
  const [selectedId, setSelectedId] = useState<string | null>(null)
  // Tracks which page was last interacted with (FieldLayer's onActivate).
  // Placement now takes its page directly from the click event, but other
  // pieces of the editor keep the "active page" concept available.
  const [, setActivePage] = useState(1)
  const [save, setSave] = useState<SaveState>({ phase: 'idle' })
  // Non-null while a sidebar tool is picked and awaiting a document click to
  // drop the field (click-to-place). Toggled off by picking the same tool
  // again, or automatically after one placement.
  const [placingType, setPlacingType] = useState<FieldType | null>(null)
  // Whether this document is signed (locked). Seeded from the server status,
  // and flipped true the moment a finalize succeeds in-session so the UI
  // switches to the locked/download state without needing a page refresh —
  // otherwise a follow-up Save would hit a 409 the user can't make sense of.
  const [isSigned, setIsSigned] = useState(status === 'signed')
  // Which field's signature-capture modal is open, if any (Task 11).
  const [signatureFieldId, setSignatureFieldId] = useState<string | null>(null)
  // Set to the template name after a successful "Save as template" so the
  // success message can link over to the Templates page.
  const [templateSaved, setTemplateSaved] = useState<string | null>(null)

  // Unsaved-changes tracking: any change to `fields` after the initial mount
  // marks the editor dirty; a successful Save/Finalize clears it. Drives the
  // beforeunload + back-link guards so placed fields aren't silently lost.
  const [dirty, setDirty] = useState(false)
  const firstFieldsRun = useRef(true)
  useEffect(() => {
    if (firstFieldsRun.current) {
      firstFieldsRun.current = false
      return
    }
    setDirty(true)
  }, [fields, recipients, signingOrder])

  // Locked = self-signed OR sent for signature: both freeze editing.
  const isLocked = isSigned || isSent

  useEffect(() => {
    if (!dirty || isLocked) return
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [dirty, isLocked])

  // Fetch + decrypt the original PDF (again after a replace).
  useEffect(() => {
    let cancelled = false
    fetch(`/api/documents/${documentId}/file/original?v=${fileVersion}`, { cache: 'no-store' })
      .then(async (res) => {
        if (!res.ok) throw new Error(String(res.status))
        return res.arrayBuffer()
      })
      .then((buf) => {
        if (!cancelled) setData(buf)
      })
      .catch(() => {
        if (!cancelled) setLoadError('Could not load the document.')
      })
    return () => {
      cancelled = true
    }
  }, [documentId, fileVersion])

  // Click-to-place: drop a field centered on the clicked point, in place of
  // the old auto-staggered default position.
  const placeField = useCallback(
    (type: FieldType, page: number, clickX: number, clickY: number) => {
      const { w, h } = DEFAULTS[type]
      const id = uid()
      const rect = clampFieldRect({ x: clickX - w / 2, y: clickY - h / 2, w, h })
      setFields((prev) => [
        ...prev,
        {
          id,
          page,
          type,
          ...rect,
          value: type === 'date' ? todayIso() : type === 'checkbox' ? 'false' : '',
          // Text fields start with the default formatting; others carry none.
          style: type === 'text' ? { ...DEFAULT_TEXT_STYLE } : undefined,
          // New fields default to required; dropdown/radio get seed options.
          required: true,
          options: defaultOptions(type),
        },
      ])
      setSelectedId(id)
      setActivePage(page)
      setPlacingType(null)
    },
    [],
  )

  const updateField = useCallback((id: string, patch: Partial<EditorField>) => {
    setFields((prev) => prev.map((f) => (f.id === id ? { ...f, ...patch } : f)))
  }, [])

  // Patch a single style property on the selected text field, merging it into
  // that field's current style (falling back to defaults if it had none).
  const updateStyle = useCallback(
    (id: string, patch: Partial<TextStyle>) => {
      setFields((prev) =>
        prev.map((f) =>
          f.id === id ? { ...f, style: { ...DEFAULT_TEXT_STYLE, ...f.style, ...patch } } : f,
        ),
      )
    },
    [],
  )

  // Select a radio option within its group: set every radio that shares the
  // same group key (and recipient assignment) to the chosen field's label, so
  // exactly one option in the group renders marked (value === its own label).
  const selectRadio = useCallback((id: string) => {
    setFields((prev) => {
      const target = prev.find((f) => f.id === id)
      if (!target || target.type !== 'radio') return prev
      const group = target.options?.group ?? ''
      const label = target.options?.label ?? ''
      const rid = target.recipientId ?? null
      return prev.map((f) =>
        f.type === 'radio' &&
        (f.options?.group ?? '') === group &&
        (f.recipientId ?? null) === rid
          ? { ...f, value: label }
          : f,
      )
    })
  }, [])

  const deleteField = useCallback((id: string) => {
    setFields((prev) => prev.filter((f) => f.id !== id))
    setSelectedId((cur) => (cur === id ? null : cur))
  }, [])

  // Assign (or unassign, recipientId=null) a field to a recipient.
  const assignField = useCallback(
    (id: string, recipientId: string | null) => {
      setFields((prev) => prev.map((f) => (f.id === id ? { ...f, recipientId } : f)))
    },
    [],
  )

  // Recipient list changes: whenever a recipient is removed, any field still
  // assigned to it is reverted to self (recipientId=null) so no field points at
  // a recipient that no longer exists.
  const handleRecipientsChange = useCallback((next: EditorRecipient[]) => {
    const ids = new Set(next.map((r) => r.id))
    setFields((prev) =>
      prev.map((f) => (f.recipientId && !ids.has(f.recipientId) ? { ...f, recipientId: null } : f)),
    )
    setRecipients(next)
  }, [])

  // Delete/Backspace removes the selected field (unless typing in an input).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Delete' && e.key !== 'Backspace') return
      if (!selectedId) return
      const t = e.target as HTMLElement | null
      const tag = t?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || t?.isContentEditable) return
      e.preventDefault()
      deleteField(selectedId)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selectedId, deleteField])

  // Strip client-only ids before emitting to the server.
  const flatFields = useMemo<FlatField[]>(
    () =>
      fields.map((f) => ({
        page: f.page,
        type: f.type,
        x: f.x,
        y: f.y,
        w: f.w,
        h: f.h,
        value: f.value,
        style: f.type === 'text' ? (f.style ?? DEFAULT_TEXT_STYLE) : undefined,
        required: f.required ?? true,
        options: f.type === 'dropdown' || f.type === 'radio' ? (f.options ?? null) : null,
        recipientId: f.recipientId ?? null,
      })),
    [fields],
  )

  // Persist recipients (+ signing order) first, so a subsequent field save can
  // reference them by id. Returns false (and sets an error) on failure.
  const saveRecipientsToServer = useCallback(async (): Promise<boolean> => {
    const res = await fetch(`/api/documents/${documentId}/recipients`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        recipients: recipients.map((r, i) => ({ id: r.id, name: r.name, email: r.email, orderIndex: i })),
        signingOrder,
      }),
    })
    if (!res.ok) {
      setSave({
        phase: 'error',
        message: res.status === 409 ? 'This document is locked.' : `Could not save recipients (${res.status}).`,
      })
      return false
    }
    return true
  }, [documentId, recipients, signingOrder])

  const persist = useCallback(
    async (kind: 'save' | 'finalize') => {
      // Finalizing is irreversible-ish (locks the doc), so require real content
      // first: at least one field, and no empty ones (an unsigned signature box
      // or a blank text field would otherwise bake an empty box into the
      // "signed" PDF).
      if (kind === 'finalize') {
        if (fields.length === 0) {
          setSave({ phase: 'error', message: 'Add at least one field before finalizing.' })
          return
        }
        // Only REQUIRED fields must be filled; optional fields may be left
        // empty. Filled-ness is type-aware (checkbox true, initials/signature
        // image, radio/dropdown a selection).
        const empty = fields.filter((f) => !isFieldFilled(f.type, f.value, f.required ?? true))
        if (empty.length > 0) {
          setSelectedId(empty[0].id)
          setSave({
            phase: 'error',
            message:
              empty.length === 1
                ? 'One field is still empty — fill it in before finalizing.'
                : `${empty.length} fields are still empty — fill them in before finalizing.`,
          })
          return
        }
      }
      setSave({ phase: 'busy' })
      try {
        // Save persists recipients + assignments too; finalize is self-sign only
        // (shown only when there are no recipients).
        if (kind === 'save') {
          if (!(await saveRecipientsToServer())) return
        }
        const url =
          kind === 'save'
            ? `/api/documents/${documentId}/fields`
            : `/api/documents/${documentId}/finalize`
        const res = await fetch(url, {
          method: kind === 'save' ? 'PUT' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ fields: flatFields }),
        })
        if (!res.ok) {
          if (res.status === 409) {
            // Already signed (locked). Reflect that in the UI so the buttons
            // switch to Download/Reset instead of leaving a dead-end error.
            setIsSigned(true)
            setSave({
              phase: 'error',
              message: 'This document is already signed. Download it, or reset it to draft to make changes.',
            })
            return
          }
          setSave({
            phase: 'error',
            message:
              res.status === 404
                ? `${kind === 'save' ? 'Save' : 'Finalize'} isn't available yet.`
                : `${kind === 'save' ? 'Save' : 'Finalize'} failed (${res.status}).`,
          })
          return
        }
        if (kind === 'finalize') setIsSigned(true)
        setDirty(false)
        setSave({
          phase: 'ok',
          message: kind === 'save' ? 'Saved.' : 'Signed. Your document is ready to download.',
        })
      } catch {
        setSave({ phase: 'error', message: 'Network error. Please try again.' })
      }
    },
    [documentId, flatFields, fields, saveRecipientsToServer],
  )

  // Send-for-signature: validate locally, then persist recipients + fields and
  // POST /send. On success the doc is locked and the returned signing links are
  // shown in the status view.
  const send = useCallback(async () => {
    if (recipients.length === 0) {
      setSave({ phase: 'error', message: 'Add at least one recipient before sending.' })
      return
    }
    const assigned = new Set(fields.map((f) => f.recipientId).filter(Boolean))
    const missing = recipients.filter((r) => !assigned.has(r.id))
    if (missing.length > 0) {
      setSave({
        phase: 'error',
        message: `Assign at least one field to each recipient (${missing.map((r) => r.name).join(', ')} ${missing.length === 1 ? 'has' : 'have'} none).`,
      })
      return
    }
    setSave({ phase: 'busy' })
    try {
      if (!(await saveRecipientsToServer())) return
      const fres = await fetch(`/api/documents/${documentId}/fields`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fields: flatFields }),
      })
      if (!fres.ok) {
        setSave({ phase: 'error', message: `Could not save fields (${fres.status}).` })
        return
      }
      // Optional expiry: a positive day count sets Document.expiresAt server-side.
      const days = expiresInDays.trim() ? Number(expiresInDays) : null
      const sres = await fetch(`/api/documents/${documentId}/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          expiresInDays: days != null && Number.isFinite(days) && days > 0 ? days : null,
          message: inviteMessage,
        }),
      })
      if (!sres.ok) {
        const body = await sres.json().catch(() => ({}))
        const map: Record<string, string> = {
          NO_RECIPIENTS: 'Add at least one recipient before sending.',
          RECIPIENT_WITHOUT_FIELD: 'Every recipient needs at least one assigned field.',
          ALREADY_SIGNED: 'This document is already locked.',
        }
        setSave({ phase: 'error', message: map[body.error] ?? `Send failed (${sres.status}).` })
        return
      }
      const body = (await sres.json()) as { recipients: SenderRecipient[] }
      setSentRecipients(body.recipients)
      setIsSent(true)
      setDirty(false)
      setSave({ phase: 'ok', message: 'Sent for signature. Copy the links below to share with each recipient.' })
    } catch {
      setSave({ phase: 'error', message: 'Network error. Please try again.' })
    }
  }, [documentId, flatFields, fields, recipients, saveRecipientsToServer, expiresInDays, inviteMessage])

  // Replace the draft's PDF with another file, keeping recipients. Fields on
  // pages the new file doesn't have are dropped (server and on screen).
  const replaceFile = useCallback(
    async (file: File) => {
      if (
        dirty &&
        !window.confirm('Replacing the PDF keeps your recipients, but unsaved field changes may be lost. Continue?')
      ) {
        return
      }
      setSave({ phase: 'busy' })
      try {
        const form = new FormData()
        form.append('file', file)
        const res = await fetch(`/api/documents/${documentId}/replace`, { method: 'POST', body: form })
        if (!res.ok) {
          const body = await res.json().catch(() => ({}))
          const map: Record<string, string> = {
            INVALID_PDF: 'That file is not a readable PDF.',
            TOO_LARGE: 'That file is too large.',
            NOT_DRAFT: 'Only a draft can have its PDF replaced.',
          }
          setSave({ phase: 'error', message: map[body.error] ?? `Could not replace the PDF (${res.status}).` })
          return
        }
        const { pageCount, removedFields } = (await res.json()) as { pageCount: number; removedFields: number }
        setFields((prev) => prev.filter((f) => f.page <= pageCount))
        setDocName(file.name)
        setData(null)
        setFileVersion((v) => v + 1)
        setSave({
          phase: 'ok',
          message:
            removedFields > 0
              ? `PDF replaced. Recipients kept; ${removedFields} field${removedFields === 1 ? '' : 's'} on pages the new file doesn’t have ${removedFields === 1 ? 'was' : 'were'} removed.`
              : 'PDF replaced. Recipients and fields kept.',
        })
      } catch {
        setSave({ phase: 'error', message: 'Network error. Please try again.' })
      }
    },
    [dirty, documentId],
  )

  // Save the current layout (PDF + placed fields + recipient roles) as a
  // reusable template. Persists the on-screen recipients + fields first so the
  // template captures what the user sees, then POSTs /api/templates.
  const saveAsTemplateAction = useCallback(async () => {
    const name = window.prompt('Name this template:', originalName)
    if (name === null) return // cancelled
    const trimmed = name.trim()
    if (!trimmed) {
      setSave({ phase: 'error', message: 'A template needs a name.' })
      return
    }
    setSave({ phase: 'busy' })
    setTemplateSaved(null)
    try {
      if (!(await saveRecipientsToServer())) return
      const fres = await fetch(`/api/documents/${documentId}/fields`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fields: flatFields }),
      })
      if (!fres.ok) {
        setSave({ phase: 'error', message: `Could not save fields (${fres.status}).` })
        return
      }
      const tres = await fetch('/api/templates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ documentId, name: trimmed }),
      })
      if (!tres.ok) {
        setSave({ phase: 'error', message: `Could not save template (${tres.status}).` })
        return
      }
      setDirty(false)
      setTemplateSaved(trimmed)
      setSave({ phase: 'ok', message: `Saved “${trimmed}” as a template.` })
    } catch {
      setSave({ phase: 'error', message: 'Network error. Please try again.' })
    }
  }, [documentId, flatFields, originalName, saveRecipientsToServer])

  // Reset a signed document back to an editable draft (deletes the signed PDF
  // server-side; the placed fields are kept so it can be re-finalized).
  const resetToDraft = useCallback(async () => {
    setSave({ phase: 'busy' })
    try {
      const res = await fetch(`/api/documents/${documentId}/reset`, { method: 'POST' })
      if (!res.ok) {
        setSave({ phase: 'error', message: `Reset failed (${res.status}).` })
        return
      }
      setIsSigned(false)
      setSave({ phase: 'ok', message: 'Reset to draft — you can edit and finalize again.' })
    } catch {
      setSave({ phase: 'error', message: 'Network error. Please try again.' })
    }
  }, [documentId])

  const busy = save.phase === 'busy'

  // A sent document that every recipient has signed is `completed`: the
  // multi-signer signed PDF is ready for the sender to download.
  const isCompleted = status === 'completed'

  // The currently-selected text field (if any) drives the formatting panel.
  const selectedField = fields.find((f) => f.id === selectedId)
  const selectedTextStyle =
    selectedField && selectedField.type === 'text'
      ? selectedField.style ?? DEFAULT_TEXT_STYLE
      : null

  const hasRecipients = recipients.length > 0

  // Status shown in the header pill: signed (self-sign) → 'signed'; sent for
  // signature → the persisted sent-lifecycle status ('sent'/'completed'/
  // 'declined'), or 'sent' right after an in-session send; otherwise draft.
  const displayStatus = isSigned
    ? 'signed'
    : isSent
      ? SENT_STATUSES.has(status)
        ? status
        : 'sent'
      : 'draft'

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6 lg:px-8">
      <Link
        href={envelopeId ? `/envelopes/${envelopeId}` : "/documents"}
        className="mb-4 inline-flex items-center gap-1.5 text-[13px] font-medium text-muted transition-colors hover:text-ink"
        onClick={(e) => {
          if (
            dirty &&
            !isLocked &&
            !window.confirm('You have unsaved changes. Leave without saving?')
          ) {
            e.preventDefault()
          }
        }}
      >
        <span aria-hidden>←</span> {envelopeId ? "Back to envelope" : "Back to documents"}
      </Link>
      <PageHeader
        title={docName}
        subtitle={
          isSigned
            ? 'This document is signed and locked. Download it, or reset to draft to make changes.'
            : isSent
              ? 'This document has been sent for signature and is locked. Track recipient status and share the signing links below.'
              : 'Place fields, add recipients to send for signature, or finalize to self-sign.'
        }
      >
        <StatusPill status={displayStatus} />
        {isSigned ? (
          <>
            <a className={buttonClasses('primary', 'md')} href={`/api/documents/${documentId}/file/signed`}>
              Download signed PDF
            </a>
            <a className={buttonClasses('secondary', 'md')} href={`/api/documents/${documentId}/audit`}>
              Download audit trail
            </a>
            <button
              type="button"
              className={buttonClasses('secondary', 'md')}
              onClick={resetToDraft}
              disabled={busy}
            >
              Reset to draft
            </button>
          </>
        ) : isSent ? (
          <>
            {isCompleted && (
              <a className={buttonClasses('primary', 'md')} href={`/api/documents/${documentId}/file/signed`}>
                Download completed PDF
              </a>
            )}
            <a className={buttonClasses('secondary', 'md')} href={`/api/documents/${documentId}/audit`}>
              Download audit trail
            </a>
          </>
        ) : (
          <>
            <button
              type="button"
              className={buttonClasses('secondary', 'md')}
              onClick={() => persist('save')}
              disabled={busy || !data}
            >
              Save
            </button>
            <button
              type="button"
              className={buttonClasses('secondary', 'md')}
              onClick={saveAsTemplateAction}
              disabled={busy || !data}
            >
              Save as template
            </button>
            <button
              type="button"
              className={buttonClasses('secondary', 'md')}
              onClick={() => replaceInput.current?.click()}
              disabled={busy}
            >
              Replace PDF
            </button>
            <input
              ref={replaceInput}
              type="file"
              accept="application/pdf,.pdf"
              className="hidden"
              aria-hidden
              tabIndex={-1}
              onChange={(e) => {
                const f = e.target.files?.[0]
                e.target.value = ''
                if (f) void replaceFile(f)
              }}
            />
            {hasRecipients ? (
              <>
                <label className="inline-flex items-center gap-1.5 text-[12px] text-muted">
                  Expires in
                  <input
                    type="number"
                    min={1}
                    inputMode="numeric"
                    value={expiresInDays}
                    onChange={(e) => setExpiresInDays(e.target.value)}
                    placeholder="—"
                    aria-label="Expires in N days (optional)"
                    className="min-h-11 w-16 rounded-lg border border-edge-strong bg-paper px-2 text-[13px] text-ink outline-none focus-visible:ring-2 focus-visible:ring-brand-primary/40"
                    disabled={busy || !data}
                  />
                  days
                </label>
                <button
                  type="button"
                  className={buttonClasses('primary', 'md')}
                  onClick={send}
                  disabled={busy || !data}
                >
                  Send for signature
                </button>
              </>
            ) : (
              <button
                type="button"
                className={buttonClasses('primary', 'md')}
                onClick={() => persist('finalize')}
                disabled={busy || !data}
              >
                Finalize
              </button>
            )}
          </>
        )}
      </PageHeader>

      {save.phase === 'error' && (
        <p className="mb-4 text-[13px] text-danger" role="alert">
          {save.message}
        </p>
      )}
      {save.phase === 'ok' && (
        <p className="mb-4 text-[13px] text-good" role="status">
          {save.message}
          {templateSaved && (
            <>
              {' '}
              <Link href="/templates" className="font-medium underline hover:text-ink">
                View templates →
              </Link>
            </>
          )}
        </p>
      )}

      {isSent && <RecipientStatusView documentId={documentId} recipients={sentRecipients} />}

      <div className="flex flex-col gap-4 md:flex-row md:gap-5">
        {!isLocked && (
          <div className="w-full shrink-0 md:sticky md:top-4 md:w-56 md:self-start">
            <FieldToolbar
              activeType={placingType}
              onPick={(t) => setPlacingType((prev) => (prev === t ? null : t))}
              disabled={!data}
            />
            {selectedTextStyle && selectedId && (
              <TextFormatPanel
                style={selectedTextStyle}
                onChange={(patch) => updateStyle(selectedId, patch)}
              />
            )}
            {selectedField && selectedId && (
              <FieldConfigPanel
                field={selectedField}
                onChange={(patch) => updateField(selectedId, patch)}
              />
            )}
            <RecipientsPanel
              recipients={recipients}
              signingOrder={signingOrder}
              onChange={handleRecipientsChange}
              onChangeSigningOrder={setSigningOrder}
              disabled={!data}
            />
            {hasRecipients && (
              <div className="mt-4 rounded-xl border border-edge bg-paper p-3">
                <label htmlFor="invite-message" className="block text-[13px] font-medium text-ink">
                  Invitation message
                </label>
                <textarea
                  id="invite-message"
                  value={inviteMessage}
                  onChange={(e) => setInviteMessage(e.target.value)}
                  maxLength={MAX_INVITE_MESSAGE}
                  rows={4}
                  className="mt-1.5 w-full rounded-lg border border-edge-strong bg-paper px-2.5 py-2 text-[13px] text-ink outline-none focus-visible:ring-2 focus-visible:ring-brand-primary/40"
                  disabled={busy}
                />
                <p className="mt-1 text-[12px] text-muted">Included in the email to each recipient. Clear it to send none.</p>
              </div>
            )}
          </div>
        )}

        <div className="min-w-0 flex-1">
          {loadError ? (
            <p className="py-10 text-center text-[14px] text-danger" role="alert">
              {loadError}
            </p>
          ) : data ? (
            <Viewer
              data={data}
              renderPageOverlay={(pageNumber, size) => (
                <FieldLayer
                  pageNumber={pageNumber}
                  size={size}
                  fields={fields.filter((f) => f.page === pageNumber)}
                  selectedId={selectedId}
                  onSelect={setSelectedId}
                  onChange={updateField}
                  onDelete={deleteField}
                  onActivate={setActivePage}
                  onRequestSignature={setSignatureFieldId}
                  onSelectRadio={selectRadio}
                  placingType={isLocked ? null : placingType}
                  onPlace={placeField}
                  recipients={isLocked ? [] : recipients}
                  onAssign={assignField}
                />
              )}
            />
          ) : (
            <p className="py-10 text-center text-[14px] text-muted">Loading document…</p>
          )}
        </div>
      </div>

      <SignatureModal
        open={signatureFieldId !== null}
        onClose={() => setSignatureFieldId(null)}
        onConfirm={(pngDataUrl) => {
          if (signatureFieldId) updateField(signatureFieldId, { value: pngDataUrl })
          setSignatureFieldId(null)
        }}
      />
    </div>
  )
}

// Read-only status view for a sent document: every recipient with their
// current signing status and a copy-able signing link. No email is sent yet
// (Phase 3) — the sender shares these links manually.
// Recipients who can still be reminded (haven't signed/declined yet).
const REMINDABLE = new Set(['pending', 'viewed'])

function RecipientStatusView({
  documentId,
  recipients,
}: {
  documentId: string
  recipients: SenderRecipient[]
}) {
  const [copiedId, setCopiedId] = useState<string | null>(null)
  // Per-recipient resend state: idle | sending | a short status message.
  const [resend, setResend] = useState<Record<string, string>>({})

  const copy = async (r: SenderRecipient) => {
    if (!r.signingUrl) return
    try {
      await navigator.clipboard.writeText(r.signingUrl)
      setCopiedId(r.id)
      setTimeout(() => setCopiedId((c) => (c === r.id ? null : c)), 1500)
    } catch {
      // Clipboard may be unavailable (non-secure context); the link is shown in
      // the input regardless, so the user can select + copy manually.
    }
  }

  // Manual reminder: POST to the org-gated remind route. Email is best-effort —
  // when SMTP isn't configured the route says so and the copy-link fallback
  // stays available.
  const remind = async (r: SenderRecipient) => {
    setResend((s) => ({ ...s, [r.id]: 'Sending…' }))
    try {
      const res = await fetch(`/api/documents/${documentId}/recipients/${r.id}/remind`, {
        method: 'POST',
      })
      const body = (await res.json().catch(() => ({}))) as { sent?: boolean; reason?: string }
      const msg = res.ok
        ? body.sent
          ? 'Reminder sent'
          : 'Email not configured — share the link'
        : 'Could not send reminder'
      setResend((s) => ({ ...s, [r.id]: msg }))
    } catch {
      setResend((s) => ({ ...s, [r.id]: 'Could not send reminder' }))
    }
    setTimeout(() => setResend((s) => ({ ...s, [r.id]: '' })), 3000)
  }

  return (
    <div className="mb-6 rounded-xl border border-edge bg-paper p-4 shadow-sm">
      <h2 className="mb-3 text-[14px] font-semibold text-ink">Recipients</h2>
      <ul className="flex flex-col gap-3">
        {recipients.map((r, i) => {
          const c = recipientColor(i)
          return (
            <li key={r.id} className="flex flex-col gap-2 border-b border-edge pb-3 last:border-0 last:pb-0">
              <div className="flex items-center gap-2">
                <span aria-hidden className="h-3 w-3 shrink-0 rounded-full" style={{ backgroundColor: c.swatch }} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13px] font-medium text-ink">{r.name}</p>
                  <p className="truncate text-[12px] text-muted">{r.email}</p>
                </div>
                <StatusPill status={r.status} label={RECIPIENT_STATUS_LABEL[r.status] ?? r.status} />
              </div>
              {r.signingUrl && (
                <div className="flex items-center gap-2">
                  <input
                    readOnly
                    aria-label={`Signing link for ${r.name}`}
                    className="min-h-9 min-w-0 flex-1 rounded-lg border border-edge-strong bg-paper px-2 text-[12px] text-ink outline-none"
                    value={r.signingUrl}
                    onFocus={(e) => e.currentTarget.select()}
                  />
                  <button
                    type="button"
                    className={buttonClasses('secondary', 'sm')}
                    onClick={() => copy(r)}
                  >
                    {copiedId === r.id ? 'Copied' : 'Copy link'}
                  </button>
                  {REMINDABLE.has(r.status) && (
                    <button
                      type="button"
                      className={buttonClasses('secondary', 'sm')}
                      onClick={() => remind(r)}
                      disabled={resend[r.id] === 'Sending…'}
                    >
                      {resend[r.id] && resend[r.id] !== '' ? resend[r.id] : 'Resend email'}
                    </button>
                  )}
                </div>
              )}
            </li>
          )
        })}
      </ul>
    </div>
  )
}
