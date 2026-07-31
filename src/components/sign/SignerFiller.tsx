'use client'

import dynamic from 'next/dynamic'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { buttonClasses } from '@/components/ui/Button'
import { SignatureModal } from '@/components/pdf-editor/SignatureModal'
import {
  cssFontStack,
  recipientColor,
  isFieldFilled,
  DEFAULT_TEXT_STYLE,
  type FieldOptions,
  type TextStyle,
} from '@/components/pdf-editor/types'
import type { PageSize } from '@/components/pdf-editor/FieldLayer'
import type { SignerField } from '@/server/documents/signing'
import { BevoraSignMark, BevoraSignWordmark } from '@/components/brand/BevoraSignMark'

// pdfjs-dist touches DOM-only globals at module scope (DOMMatrix, …), so the
// Viewer must be client-only — same reason the editor imports it with ssr:false.
const Viewer = dynamic(() => import('@/components/pdf-editor/Viewer').then((m) => m.Viewer), {
  ssr: false,
})

interface SignerFillerProps {
  token: string
  recipientName: string
  documentName: string
  fields: SignerField[]
  // Phase 5 — white-label branding. All null ⇒ generic Bevora Sign identity
  // (unbranded, exactly as before). When set, the header shows the org's
  // name/logo and the brand colour re-tints the signing accents.
  brandName?: string | null
  brandColor?: string | null
  brandLogo?: string | null
}

// The signing header identity: the org's logo/name when branded, else the
// Bevora Sign mark + wordmark. Shown above the document on the signer surface.
function BrandHeader({
  brandName,
  brandLogo,
}: {
  brandName?: string | null
  brandLogo?: string | null
}) {
  const branded = !!brandName
  return (
    <div className="mb-4 flex items-center gap-2.5">
      {branded ? (
        brandLogo ? (
          // eslint-disable-next-line @next/next/no-img-element -- inlined data: URI, not a Next asset
          <img src={brandLogo} alt={brandName!} className="h-8 w-auto max-w-[180px] object-contain" />
        ) : (
          <span className="text-[16px] font-semibold tracking-[-0.02em] text-brand-primary">{brandName}</span>
        )
      ) : (
        <>
          <BevoraSignMark size={28} />
          <BevoraSignWordmark className="text-[15px] text-ink" />
        </>
      )}
    </div>
  )
}

type Phase = 'filling' | 'signed' | 'completed' | 'declined'

// Is one of MY fields satisfied? Delegates to the shared type-aware +
// required-aware helper (optional fields are always "filled").
function fieldSatisfied(f: SignerField, value: string): boolean {
  return isFieldFilled(f.type, value, f.required)
}

export function SignerFiller({
  token,
  recipientName,
  documentName,
  fields,
  brandName,
  brandColor,
  brandLogo,
}: SignerFillerProps) {
  // Re-tint every `brand-primary` accent (buttons, progress, field highlights)
  // to the org colour by overriding the CSS variable on the subtree. Unbranded
  // ⇒ undefined ⇒ the product green from globals.css stands.
  const brandStyle = brandColor
    ? ({ '--brand-primary': brandColor, '--brand-primary-dark': brandColor } as React.CSSProperties)
    : undefined
  const [data, setData] = useState<ArrayBuffer | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const myFields = useMemo(() => fields.filter((f) => f.mine), [fields])

  // Editable values for THIS recipient's fields only, keyed by fieldId.
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(myFields.map((f) => [f.id, f.value])),
  )
  const [phase, setPhase] = useState<Phase>('filling')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [started, setStarted] = useState(false)
  const [signatureFieldId, setSignatureFieldId] = useState<string | null>(null)

  // DOM refs for each of my field boxes, so "Next" can scroll to the next empty.
  const boxRefs = useRef<Record<string, HTMLElement | null>>({})

  // Fetch + decrypt the original PDF via the TOKEN-authorized endpoint (never
  // the org-scoped /api/documents route — the recipient has no session).
  useEffect(() => {
    let cancelled = false
    fetch(`/api/sign/${token}`)
      .then(async (res) => {
        if (!res.ok) throw new Error(String(res.status))
        return res.arrayBuffer()
      })
      .then((buf) => {
        if (!cancelled) setData(buf)
      })
      .catch(() => {
        if (!cancelled) setLoadError('Could not load this document.')
      })
    return () => {
      cancelled = true
    }
  }, [token])

  const setValue = useCallback((id: string, value: string) => {
    setValues((prev) => ({ ...prev, [id]: value }))
  }, [])

  // Select a radio option: set every one of MY radio fields sharing the same
  // group to the chosen field's label, so only one renders marked.
  const selectRadio = useCallback(
    (id: string) => {
      const target = myFields.find((f) => f.id === id)
      if (!target || target.type !== 'radio') return
      const group = target.options?.group ?? ''
      const label = target.options?.label ?? ''
      setValues((prev) => {
        const next = { ...prev }
        for (const f of myFields) {
          if (f.type === 'radio' && (f.options?.group ?? '') === group) next[f.id] = label
        }
        return next
      })
    },
    [myFields],
  )

  const filledCount = myFields.filter((f) => fieldSatisfied(f, values[f.id] ?? '')).length
  const allFilled = filledCount === myFields.length && myFields.length > 0

  const jumpToNextEmpty = useCallback(() => {
    setStarted(true)
    const next = myFields.find((f) => !fieldSatisfied(f, values[f.id] ?? ''))
    if (!next) return
    const el = boxRefs.current[next.id]
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' })
      if (next.type === 'signature' || next.type === 'initials') {
        setSignatureFieldId(next.id)
      } else {
        ;(el.querySelector('input, textarea, select, button') as HTMLElement | null)?.focus()
      }
    }
  }, [myFields, values])

  const finish = useCallback(async () => {
    if (!allFilled) return
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`/api/sign/${token}/complete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ values: myFields.map((f) => ({ fieldId: f.id, value: values[f.id] ?? '' })) }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        const map: Record<string, string> = {
          invalid_values: 'Please fill in all of your fields before finishing.',
          waiting: 'It is not your turn to sign yet.',
          inactive: 'This document is no longer accepting signatures.',
          done_signed: 'You have already signed this document.',
          done_declined: 'This signing request was declined.',
          not_found: 'This signing link is no longer valid.',
        }
        setError(map[body.error] ?? `Could not submit (${res.status}).`)
        return
      }
      const body = (await res.json()) as { status: 'signed' | 'completed' }
      setPhase(body.status === 'completed' ? 'completed' : 'signed')
    } catch {
      setError('Network error. Please try again.')
    } finally {
      setBusy(false)
    }
  }, [allFilled, token, myFields, values])

  const decline = useCallback(async () => {
    if (!window.confirm('Decline to sign this document? This cannot be undone.')) return
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`/api/sign/${token}/decline`, { method: 'POST' })
      if (!res.ok) {
        setError(`Could not decline (${res.status}).`)
        return
      }
      setPhase('declined')
    } catch {
      setError('Network error. Please try again.')
    } finally {
      setBusy(false)
    }
  }, [token])

  // Terminal states after submitting.
  if (phase === 'signed' || phase === 'completed') {
    return (
      <FinishedCard
        style={brandStyle}
        emoji="✓"
        title="Thank you — you've signed."
        body={
          phase === 'completed'
            ? 'All recipients have now signed. The completed document has been finalized.'
            : 'Your signature has been recorded. We are waiting on the other recipients to finish.'
        }
      />
    )
  }
  if (phase === 'declined') {
    return (
      <FinishedCard
        style={brandStyle}
        emoji="✕"
        title="You declined to sign."
        body="No signature was recorded and the request has been closed."
      />
    )
  }

  return (
    <div className="mx-auto max-w-4xl px-4 pb-28 pt-6 sm:px-6" style={brandStyle}>
      <BrandHeader brandName={brandName} brandLogo={brandLogo} />
      <header className="mb-5">
        <p className="text-[12px] font-medium uppercase tracking-wide text-muted">Signature request</p>
        <h1 className="mt-1 truncate text-[20px] font-semibold text-ink">{documentName}</h1>
        <p className="mt-1 text-[13px] text-muted">
          Signing as <span className="font-medium text-ink">{recipientName}</span>. Fill in the
          {myFields.length === 1 ? ' highlighted field' : ` ${myFields.length} highlighted fields`}, then choose Finish.
        </p>
      </header>

      {error && (
        <p className="mb-4 rounded-lg border border-danger/30 bg-danger/5 px-3 py-2 text-[13px] text-danger" role="alert">
          {error}
        </p>
      )}

      {loadError ? (
        <p className="py-10 text-center text-[14px] text-danger" role="alert">
          {loadError}
        </p>
      ) : data ? (
        <Viewer
          data={data}
          renderPageOverlay={(pageNumber, size) => (
            <SignOverlay
              size={size}
              fields={fields.filter((f) => f.page === pageNumber)}
              values={values}
              started={started}
              onSetValue={setValue}
              onSelectRadio={selectRadio}
              onRequestSignature={setSignatureFieldId}
              registerRef={(id, el) => {
                boxRefs.current[id] = el
              }}
            />
          )}
        />
      ) : (
        <p className="py-10 text-center text-[14px] text-muted">Loading document…</p>
      )}

      {/* Sticky action bar — mobile-friendly guided finish. */}
      <div className="fixed inset-x-0 bottom-0 z-40 border-t border-edge bg-paper/95 backdrop-blur">
        <div className="mx-auto flex max-w-4xl items-center gap-3 px-4 py-3 sm:px-6">
          <div className="min-w-0 flex-1">
            <p className="text-[13px] font-medium text-ink">
              {filledCount} of {myFields.length} fields completed
            </p>
            <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-shell">
              <div
                className="h-full rounded-full bg-brand-primary transition-all"
                style={{ width: `${myFields.length ? (filledCount / myFields.length) * 100 : 0}%` }}
              />
            </div>
          </div>
          <button type="button" className={buttonClasses('secondary', 'md')} onClick={decline} disabled={busy}>
            Decline
          </button>
          {allFilled ? (
            <button type="button" className={buttonClasses('primary', 'md')} onClick={finish} disabled={busy}>
              {busy ? 'Finishing…' : 'Finish signing'}
            </button>
          ) : (
            <button type="button" className={buttonClasses('primary', 'md')} onClick={jumpToNextEmpty} disabled={busy}>
              {started ? 'Next field' : 'Start'}
            </button>
          )}
        </div>
      </div>

      <SignatureModal
        open={signatureFieldId !== null}
        onClose={() => setSignatureFieldId(null)}
        onConfirm={(pngDataUrl) => {
          if (signatureFieldId) setValue(signatureFieldId, pngDataUrl)
          setSignatureFieldId(null)
        }}
      />
    </div>
  )
}

// Per-page overlay: my fields are fillable; everyone else's are read-only,
// greyed, and labelled with their assignee — context, but not editable.
function SignOverlay({
  size,
  fields,
  values,
  started,
  onSetValue,
  onSelectRadio,
  onRequestSignature,
  registerRef,
}: {
  size: PageSize
  fields: SignerField[]
  values: Record<string, string>
  started: boolean
  onSetValue: (id: string, value: string) => void
  onSelectRadio: (id: string) => void
  onRequestSignature: (id: string) => void
  registerRef: (id: string, el: HTMLElement | null) => void
}) {
  return (
    <div className="absolute inset-0">
      {fields.map((f) => {
        const style: React.CSSProperties = {
          left: `${f.x * size.width}px`,
          top: `${f.y * size.height}px`,
          width: `${f.w * size.width}px`,
          height: `${f.h * size.height}px`,
        }
        if (!f.mine) {
          const c = f.colorIndex >= 0 ? recipientColor(f.colorIndex) : null
          // Show a text preview for value-bearing types; image types
          // (signature/initials) and empty ones fall back to the assignee label.
          const isImageType = f.type === 'signature' || f.type === 'initials'
          const preview =
            f.type === 'checkbox'
              ? f.value === 'true'
                ? '☑'
                : '☐'
              : f.value
          return (
            <div
              key={f.id}
              className="absolute box-border overflow-hidden rounded-md border border-dashed opacity-70"
              style={{
                ...style,
                borderColor: c?.border ?? '#9ca3af',
                backgroundColor: c?.bg ?? 'rgba(156,163,175,0.08)',
              }}
              title={`${f.assigneeLabel}'s field`}
            >
              {!isImageType && preview ? (
                <span className="block truncate px-1 py-0.5 text-[11px] text-muted">{preview}</span>
              ) : (
                <span className="block truncate px-1 py-0.5 text-[10px] italic text-muted">{f.assigneeLabel}</span>
              )}
            </div>
          )
        }

        const filled = fieldSatisfied(f, values[f.id] ?? '')
        // Pulse the highlight for still-empty fields once the user has started.
        const attention = started && !filled
        return (
          <div
            key={f.id}
            ref={(el) => registerRef(f.id, el)}
            className={`absolute box-border rounded-md border-2 ${
              attention ? 'border-brand-primary ring-2 ring-brand-primary/40' : 'border-brand-primary/70'
            } bg-brand-primary/5`}
            style={style}
          >
            <MyFieldBody
              field={f}
              size={size}
              value={values[f.id] ?? ''}
              onSetValue={onSetValue}
              onSelectRadio={onSelectRadio}
              onRequestSignature={onRequestSignature}
            />
          </div>
        )
      })}
    </div>
  )
}

function MyFieldBody({
  field,
  size,
  value,
  onSetValue,
  onSelectRadio,
  onRequestSignature,
}: {
  field: SignerField
  size: PageSize
  value: string
  onSetValue: (id: string, value: string) => void
  onSelectRadio: (id: string) => void
  onRequestSignature: (id: string) => void
}) {
  if (field.type === 'signature' || field.type === 'initials') {
    const hasImage = value.startsWith('data:image')
    const label = field.type === 'initials' ? 'initials' : 'signature'
    return (
      <button
        type="button"
        aria-label={hasImage ? `Change ${label}` : `Tap to add ${label}`}
        className="flex h-full w-full items-center justify-center overflow-hidden px-1 text-[12px] font-medium text-brand-primary-dark"
        onClick={() => onRequestSignature(field.id)}
      >
        {hasImage ? (
          // eslint-disable-next-line @next/next/no-img-element -- data: URL, not a Next asset
          <img src={value} alt={`Your ${label}`} draggable={false} className="h-full w-full object-contain" />
        ) : (
          <span className="truncate italic">{field.type === 'initials' ? 'Tap for initials' : 'Tap to sign'}</span>
        )}
      </button>
    )
  }

  if (field.type === 'checkbox') {
    const checked = value === 'true'
    return (
      <button
        type="button"
        role="checkbox"
        aria-checked={checked}
        aria-label="Checkbox"
        className="flex h-full w-full items-center justify-center text-brand-primary-dark"
        onClick={() => onSetValue(field.id, checked ? 'false' : 'true')}
      >
        {checked && <span className="text-[18px] font-bold leading-none">✓</span>}
      </button>
    )
  }

  if (field.type === 'radio') {
    const marked = !!field.options?.label && value === field.options.label
    return (
      <button
        type="button"
        role="radio"
        aria-checked={marked}
        aria-label={`Radio option${field.options?.label ? ` ${field.options.label}` : ''}`}
        className="flex h-full w-full items-center justify-center"
        onClick={() => onSelectRadio(field.id)}
      >
        <span className="flex aspect-square h-3/4 items-center justify-center rounded-full border-2 border-brand-primary">
          {marked && <span className="h-1/2 w-1/2 rounded-full bg-brand-primary" />}
        </span>
      </button>
    )
  }

  if (field.type === 'dropdown') {
    const opts: FieldOptions = (field.options as FieldOptions | null) ?? {}
    const choices = opts.choices ?? []
    return (
      <select
        aria-label="Select an option"
        className="h-full w-full cursor-pointer bg-transparent px-1.5 text-[13px] text-ink outline-none"
        value={value}
        onChange={(e) => onSetValue(field.id, e.target.value)}
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

  if (field.type === 'date') {
    return (
      <input
        type="date"
        value={value}
        aria-label="Date"
        className="h-full w-full cursor-pointer bg-transparent px-1.5 text-[13px] text-ink outline-none"
        onChange={(e) => onSetValue(field.id, e.target.value)}
      />
    )
  }

  // text — honour the sender's saved style for a faithful preview.
  const s: TextStyle = { ...DEFAULT_TEXT_STYLE, ...((field.style as Partial<TextStyle> | null) ?? {}) }
  const fontSizePx = Math.max(6, (s.fontSize * size.height) / 792)
  return (
    <textarea
      value={value}
      placeholder="Type here"
      aria-label="Text"
      rows={1}
      className="h-full w-full resize-none overflow-hidden whitespace-pre-wrap break-words bg-transparent px-1.5 py-0.5 leading-tight outline-none placeholder:text-muted"
      style={{
        fontFamily: cssFontStack(s.fontFamily),
        fontSize: `${fontSizePx}px`,
        color: s.color,
        backgroundColor: s.highlight ?? 'transparent',
        fontWeight: s.bold ? 700 : 400,
        fontStyle: s.italic ? 'italic' : 'normal',
        textDecoration: s.underline ? 'underline' : 'none',
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && !e.shiftKey) e.preventDefault()
      }}
      onChange={(e) => onSetValue(field.id, e.target.value)}
    />
  )
}

function FinishedCard({
  emoji,
  title,
  body,
  style,
}: {
  emoji: string
  title: string
  body: string
  style?: React.CSSProperties
}) {
  return (
    <div className="mx-auto flex min-h-[60vh] max-w-md flex-col items-center justify-center px-6 text-center" style={style}>
      <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-brand-primary/10 text-[24px] text-brand-primary">
        {emoji}
      </div>
      <h1 className="text-[20px] font-semibold text-ink">{title}</h1>
      <p className="mt-2 text-[14px] text-muted">{body}</p>
    </div>
  )
}
