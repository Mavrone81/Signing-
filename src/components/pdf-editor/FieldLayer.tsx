'use client'

import { useRef, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react'
import { clampFieldRect } from '@/lib/coords'
import {
  DEFAULT_TEXT_STYLE,
  cssFontStack,
  recipientColor,
  type EditorField,
  type EditorRecipient,
  type FieldType,
  type RecipientColor,
} from './types'

export interface PageSize {
  width: number
  height: number
}

interface FieldLayerProps {
  pageNumber: number
  size: PageSize
  // Fields already filtered to this page.
  fields: EditorField[]
  selectedId: string | null
  onSelect: (id: string | null) => void
  onChange: (id: string, patch: Partial<EditorField>) => void
  onDelete: (id: string) => void
  onActivate: (pageNumber: number) => void
  // Opens the Task 11 signature/initials capture modal for this field (Editor
  // owns the modal's open state).
  onRequestSignature: (fieldId: string) => void
  // Selects a radio field within its group (Editor sets every same-group radio
  // to the chosen option's label so only one renders marked).
  onSelectRadio: (fieldId: string) => void
  // Non-null while a sidebar tool is picked and awaiting a document click to
  // drop the field (click-to-place). When set, the layer shows a crosshair
  // cursor and a pointer-down on empty page area places the field instead of
  // clearing the selection.
  placingType: FieldType | null
  onPlace: (type: FieldType, pageNumber: number, x: number, y: number) => void
  // Send-for-signature: the document's recipients (empty = self-sign mode, no
  // assign-to selector shown). `onAssign` sets a field's recipientId (or null
  // for "Me / self").
  recipients: EditorRecipient[]
  onAssign: (fieldId: string, recipientId: string | null) => void
}

// The tint for a field assigned to `recipientId`, or null when it's a self /
// unassigned field (which keeps the default brand-primary styling).
function fieldColor(
  recipientId: string | null | undefined,
  recipients: EditorRecipient[],
): RecipientColor | null {
  if (!recipientId) return null
  const idx = recipients.findIndex((r) => r.id === recipientId)
  return idx === -1 ? null : recipientColor(idx)
}

const TYPE_LABEL: Record<EditorField['type'], string> = {
  signature: 'Signature',
  initials: 'Initials',
  date: 'Date',
  text: 'Text',
  checkbox: 'Checkbox',
  radio: 'Radio',
  dropdown: 'Dropdown',
}

// Absolute overlay sitting exactly over a rendered page canvas. Renders the
// page's field boxes and handles select / drag / resize / inline-edit. All
// geometry is kept normalized (0..1); pointer deltas are divided by the
// rendered page pixel size before being applied.
export function FieldLayer({
  pageNumber,
  size,
  fields,
  selectedId,
  onSelect,
  onChange,
  onDelete,
  onActivate,
  onRequestSignature,
  onSelectRadio,
  placingType,
  onPlace,
  recipients,
  onAssign,
}: FieldLayerProps) {
  return (
    <div
      className={`absolute inset-0 ${placingType ? 'cursor-crosshair' : ''}`}
      // A pointer-down that reaches the layer itself (not a box): while a
      // tool is picked, drop the field centered on the click; otherwise
      // clear the selection and mark this page active for the sidebar.
      onPointerDown={(e) => {
        if (placingType) {
          const rect = e.currentTarget.getBoundingClientRect()
          const x = (e.clientX - rect.left) / size.width
          const y = (e.clientY - rect.top) / size.height
          onPlace(placingType, pageNumber, x, y)
          return
        }
        onActivate(pageNumber)
        onSelect(null)
      }}
    >
      {fields.map((f) => (
        <FieldBox
          key={f.id}
          field={f}
          size={size}
          selected={f.id === selectedId}
          onSelect={onSelect}
          onChange={onChange}
          onDelete={onDelete}
          onRequestSignature={onRequestSignature}
          onSelectRadio={onSelectRadio}
          recipients={recipients}
          onAssign={onAssign}
          color={fieldColor(f.recipientId, recipients)}
        />
      ))}
    </div>
  )
}

type DragMode = 'move' | 'resize'

interface DragState {
  mode: DragMode
  startPointerX: number
  startPointerY: number
  startX: number
  startY: number
  startW: number
  startH: number
  // Whether the pointer has moved beyond the tap threshold since pointer-down
  // — distinguishes a genuine drag from a tap (which should open the
  // signature modal / focus the input instead of moving the box).
  moved: boolean
}

function FieldBox({
  field,
  size,
  selected,
  onSelect,
  onChange,
  onDelete,
  onRequestSignature,
  onSelectRadio,
  recipients,
  onAssign,
  color,
}: {
  field: EditorField
  size: PageSize
  selected: boolean
  onSelect: (id: string | null) => void
  onChange: (id: string, patch: Partial<EditorField>) => void
  onDelete: (id: string) => void
  onRequestSignature: (fieldId: string) => void
  onSelectRadio: (fieldId: string) => void
  recipients: EditorRecipient[]
  onAssign: (fieldId: string, recipientId: string | null) => void
  color: RecipientColor | null
}) {
  const drag = useRef<DragState | null>(null)

  function beginDrag(
    e: ReactPointerEvent,
    mode: DragMode,
  ) {
    e.stopPropagation()
    onSelect(field.id)
    drag.current = {
      mode,
      startPointerX: e.clientX,
      startPointerY: e.clientY,
      startX: field.x,
      startY: field.y,
      startW: field.w,
      startH: field.h,
      moved: false,
    }
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }

  function onPointerMove(e: ReactPointerEvent) {
    const d = drag.current
    if (!d) return
    if (!d.moved && (Math.abs(e.clientX - d.startPointerX) > 3 || Math.abs(e.clientY - d.startPointerY) > 3)) {
      d.moved = true
    }
    const dx = (e.clientX - d.startPointerX) / size.width
    const dy = (e.clientY - d.startPointerY) / size.height
    if (d.mode === 'move') {
      onChange(
        field.id,
        clampFieldRect({ x: d.startX + dx, y: d.startY + dy, w: d.startW, h: d.startH }),
      )
    } else {
      onChange(
        field.id,
        clampFieldRect({ x: d.startX, y: d.startY, w: d.startW + dx, h: d.startH + dy }),
      )
    }
  }

  function endDrag(e: ReactPointerEvent) {
    const d = drag.current
    if (d) {
      const { mode, moved } = d
      drag.current = null
      try {
        ;(e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId)
      } catch {
        // pointer capture may already be gone — ignore
      }
      // A genuine tap (no drag movement) on a move-handle: run the field's
      // primary action — open the capture modal (signature/initials), toggle a
      // checkbox, select a radio, or focus the text/date/dropdown input.
      if (mode === 'move' && !moved) {
        if (field.type === 'signature' || field.type === 'initials') {
          onRequestSignature(field.id)
        } else if (field.type === 'checkbox') {
          onChange(field.id, { value: field.value === 'true' ? 'false' : 'true' })
        } else if (field.type === 'radio') {
          onSelectRadio(field.id)
        } else {
          ;(
            (e.currentTarget as HTMLElement).querySelector('input, textarea, select') as
              | HTMLElement
              | null
          )?.focus()
        }
      }
    }
  }

  const style: CSSProperties = {
    left: `${field.x * size.width}px`,
    top: `${field.y * size.height}px`,
    width: `${field.w * size.width}px`,
    height: `${field.h * size.height}px`,
    // Colour-code by assigned recipient (overrides the default brand tint from
    // the className below). Self / unassigned fields keep the brand styling.
    ...(color
      ? { borderColor: color.border, backgroundColor: color.bg, boxShadow: selected ? '0 1px 2px rgba(0,0,0,0.08)' : undefined }
      : {}),
  }

  return (
    <div
      role="group"
      aria-label={`${TYPE_LABEL[field.type]} field`}
      className={`absolute box-border cursor-move touch-none select-none rounded-md border-2 ${
        color
          ? ''
          : selected
            ? 'border-brand-primary bg-brand-primary/10 shadow-sm'
            : 'border-brand-primary/50 bg-brand-primary/5 hover:border-brand-primary'
      }`}
      style={style}
      onPointerDown={(e) => beginDrag(e, 'move')}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
    >
      <FieldBody field={field} size={size} onChange={onChange} />

      {/* Assign-to selector — only in send-for-signature mode (recipients
          present). Sits above the box; its own pointer events are stopped so
          interacting with it never starts a drag. */}
      {recipients.length > 0 && (
        <select
          aria-label="Assign field to"
          className="absolute -top-6 left-0 max-w-full rounded border border-edge-strong bg-paper px-1 py-0.5 text-[10px] text-ink shadow-sm outline-none"
          value={field.recipientId ?? ''}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => onAssign(field.id, e.target.value === '' ? null : e.target.value)}
        >
          <option value="">Me / self</option>
          {recipients.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </select>
      )}

      {selected && (
        <>
          {/* Delete button — 44px touch target, offset above the corner. */}
          <button
            type="button"
            aria-label="Remove field"
            className="absolute -right-2 -top-2 flex h-11 w-11 items-center justify-center"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation()
              onDelete(field.id)
            }}
          >
            <span className="flex h-5 w-5 items-center justify-center rounded-full bg-danger text-[12px] font-bold leading-none text-white shadow">
              ×
            </span>
          </button>

          {/* Resize handle — 44px touch hit area, visible dot at the corner. */}
          <div
            role="slider"
            aria-label="Resize field"
            aria-valuenow={Math.round(field.w * 100)}
            tabIndex={-1}
            className="absolute -bottom-5 -right-5 flex h-11 w-11 cursor-se-resize touch-none items-center justify-center"
            onPointerDown={(e) => beginDrag(e, 'resize')}
            onPointerMove={onPointerMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
          >
            <span className="h-3 w-3 rounded-sm border-2 border-brand-primary bg-paper" />
          </div>
        </>
      )}
    </div>
  )
}

// Inner content of a box: signature placeholder, date value, or an editable
// text input. Every box is draggable from anywhere (move handled by the
// parent FieldBox); these inputs only claim the pointer-down for themselves
// once already focused, so a first tap can still start a drag/tap-to-focus
// but a focused input can be clicked into / text-selected without moving
// the box.
function FieldBody({
  field,
  size,
  onChange,
}: {
  field: EditorField
  size: PageSize
  onChange: (id: string, patch: Partial<EditorField>) => void
}) {
  if (field.type === 'text') {
    const s = { ...DEFAULT_TEXT_STYLE, ...field.style }
    // Approximate the pt→px scale for the rendered page. We don't know the
    // PDF's point height here, so assume a US-Letter-ish 792pt page — close
    // enough for a WYSIWYG-ish preview (finalize uses the exact pt size).
    const fontSizePx = Math.max(6, (s.fontSize * size.height) / 792)
    return (
      <textarea
        value={field.value}
        placeholder="Text"
        aria-label="Text field value"
        rows={1}
        className="h-full w-full resize-none cursor-text overflow-hidden whitespace-pre-wrap break-words px-1.5 py-0.5 leading-tight outline-none placeholder:text-muted"
        style={{
          fontFamily: cssFontStack(s.fontFamily),
          fontSize: `${fontSizePx}px`,
          color: s.color,
          backgroundColor: s.highlight ?? 'transparent',
          fontWeight: s.bold ? 700 : 400,
          fontStyle: s.italic ? 'italic' : 'normal',
          textDecoration: s.underline ? 'underline' : 'none',
        }}
        onPointerDown={(e) => {
          if (document.activeElement === e.currentTarget) e.stopPropagation()
        }}
        onKeyDown={(e) => {
          // Shift+Enter inserts a newline (textarea default); a plain Enter
          // must NOT add a line — prevent it so single-line entries stay tidy.
          if (e.key === 'Enter' && !e.shiftKey) e.preventDefault()
        }}
        onChange={(e) => onChange(field.id, { value: e.target.value })}
      />
    )
  }

  if (field.type === 'date') {
    // Stored value is an ISO date (yyyy-mm-dd); editable via a date picker.
    return (
      <input
        type="date"
        value={field.value}
        aria-label="Date field value"
        className="h-full w-full cursor-pointer bg-transparent px-1.5 text-[13px] text-ink outline-none"
        onPointerDown={(e) => {
          if (document.activeElement === e.currentTarget) e.stopPropagation()
        }}
        onChange={(e) => onChange(field.id, { value: e.target.value })}
      />
    )
  }

  if (field.type === 'checkbox') {
    // A box; a genuine tap toggles value (handled by the parent's endDrag).
    const checked = field.value === 'true'
    return (
      <div
        aria-label={`Checkbox field — ${checked ? 'checked' : 'unchecked'}, tap to toggle`}
        title="Checkbox — tap to toggle, drag to move"
        className="flex h-full w-full items-center justify-center text-brand-primary-dark"
      >
        {checked && <span className="text-[16px] font-bold leading-none">✓</span>}
      </div>
    )
  }

  if (field.type === 'radio') {
    // One option of a group; MARKED when the group's chosen label (value)
    // equals this field's own label. A genuine tap selects it (parent endDrag).
    const marked = !!field.options?.label && field.value === field.options.label
    return (
      <div
        aria-label={`Radio option${field.options?.label ? ` "${field.options.label}"` : ''} — tap to select`}
        title="Radio — tap to select, drag to move"
        className="flex h-full w-full items-center justify-center"
      >
        <span className="flex h-full max-h-full w-auto items-center justify-center">
          <span className="flex aspect-square h-3/4 items-center justify-center rounded-full border-2 border-brand-primary">
            {marked && <span className="h-1/2 w-1/2 rounded-full bg-brand-primary" />}
          </span>
        </span>
      </div>
    )
  }

  if (field.type === 'dropdown') {
    const choices = field.options?.choices ?? []
    return (
      <select
        aria-label="Dropdown field value"
        className="h-full w-full cursor-pointer bg-transparent px-1.5 text-[13px] text-ink outline-none"
        value={field.value}
        onPointerDown={(e) => {
          if (document.activeElement === e.currentTarget) e.stopPropagation()
        }}
        onChange={(e) => onChange(field.id, { value: e.target.value })}
      >
        <option value="">Select…</option>
        {choices.map((c, i) => (
          <option key={i} value={c}>
            {c}
          </option>
        ))}
      </select>
    )
  }

  if (field.type === 'initials') {
    // Like signature but a smaller "Initials" placeholder; tap opens the
    // capture modal (parent endDrag → onRequestSignature).
    const hasInitials = field.value.startsWith('data:image')
    return (
      <div
        aria-label={hasInitials ? 'Initials field — tap to change, drag to move' : 'Initials field — tap to add, drag to move'}
        title={hasInitials ? 'Initials — tap to change, drag to move' : 'Initials — tap to add, drag to move'}
        className="flex h-full w-full items-center justify-center overflow-hidden px-1 text-[12px] font-medium text-brand-primary-dark"
      >
        {hasInitials ? (
          // eslint-disable-next-line @next/next/no-img-element -- data: URL, not a Next-optimizable asset
          <img src={field.value} draggable={false} className="h-full w-full object-contain" alt="Initials" />
        ) : (
          <span className="truncate italic opacity-70">Initials</span>
        )}
      </div>
    )
  }

  // signature — a plain div (not a button, so it never stops the drag
  // gesture); tapping it is handled by the parent FieldBox's endDrag, which
  // opens the Task 11 capture modal for a genuine tap (not a drag). Renders
  // the captured image once the field's value is a PNG data URL.
  const hasImage = field.value.startsWith('data:image')
  return (
    <div
      aria-label={hasImage ? 'Signature field — tap to change, drag to move' : 'Signature field — tap to sign, drag to move'}
      title={hasImage ? 'Signature field — tap to change, drag to move' : 'Signature field — tap to sign, drag to move'}
      className="flex h-full w-full items-center justify-center overflow-hidden px-1 text-[13px] font-medium text-brand-primary-dark"
    >
      {hasImage ? (
        // eslint-disable-next-line @next/next/no-img-element -- data: URL, not a Next-optimizable asset
        <img src={field.value} draggable={false} className="h-full w-full object-contain" alt="Signature" />
      ) : (
        <span className="truncate italic opacity-70">Signature</span>
      )}
    </div>
  )
}
