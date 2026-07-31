'use client'

import { useState } from 'react'
import { buttonClasses } from '@/components/ui/Button'
import { uid } from '@/lib/uid'
import { recipientColor, type EditorRecipient, type SigningOrder } from './types'

interface RecipientsPanelProps {
  recipients: EditorRecipient[]
  signingOrder: SigningOrder
  onChange: (recipients: EditorRecipient[]) => void
  onChangeSigningOrder: (order: SigningOrder) => void
  disabled?: boolean
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

// Left-sidebar panel for preparing a send-for-signature: add/remove/reorder
// recipients and pick the signing order. Each recipient shows its colour
// swatch (matching the tint of the fields assigned to it in the document).
export function RecipientsPanel({
  recipients,
  signingOrder,
  onChange,
  onChangeSigningOrder,
  disabled,
}: RecipientsPanelProps) {
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [error, setError] = useState<string | null>(null)

  function add() {
    const n = name.trim()
    const e = email.trim()
    if (!n) {
      setError('Enter a name.')
      return
    }
    if (!EMAIL_RE.test(e)) {
      setError('Enter a valid email address.')
      return
    }
    if (recipients.some((r) => r.email.toLowerCase() === e.toLowerCase())) {
      setError('That email is already a recipient.')
      return
    }
    onChange([...recipients, { id: uid(), name: n, email: e }])
    setName('')
    setEmail('')
    setError(null)
  }

  function remove(id: string) {
    onChange(recipients.filter((r) => r.id !== id))
  }

  function move(index: number, dir: -1 | 1) {
    const next = [...recipients]
    const target = index + dir
    if (target < 0 || target >= next.length) return
    ;[next[index], next[target]] = [next[target], next[index]]
    onChange(next)
  }

  return (
    <div
      className="mt-3 flex flex-col gap-3 rounded-xl border border-edge bg-paper p-3 shadow-sm"
      role="group"
      aria-label="Recipients"
    >
      <span className="text-[13px] font-medium text-muted">Recipients</span>

      {recipients.length > 0 && (
        <ul className="flex flex-col gap-1.5">
          {recipients.map((r, i) => {
            const c = recipientColor(i)
            return (
              <li key={r.id} className="flex items-center gap-2 rounded-lg border border-edge px-2 py-1.5">
                <span
                  aria-hidden
                  className="h-3 w-3 shrink-0 rounded-full"
                  style={{ backgroundColor: c.swatch }}
                />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[12px] font-medium text-ink">{r.name}</p>
                  <p className="truncate text-[11px] text-muted">{r.email}</p>
                </div>
                {signingOrder === 'sequential' && (
                  <div className="flex flex-col">
                    <button
                      type="button"
                      aria-label={`Move ${r.name} up`}
                      className="px-1 text-[11px] leading-none text-muted hover:text-ink disabled:opacity-30"
                      onClick={() => move(i, -1)}
                      disabled={disabled || i === 0}
                    >
                      ▲
                    </button>
                    <button
                      type="button"
                      aria-label={`Move ${r.name} down`}
                      className="px-1 text-[11px] leading-none text-muted hover:text-ink disabled:opacity-30"
                      onClick={() => move(i, 1)}
                      disabled={disabled || i === recipients.length - 1}
                    >
                      ▼
                    </button>
                  </div>
                )}
                <button
                  type="button"
                  aria-label={`Remove ${r.name}`}
                  className="px-1 text-[13px] leading-none text-danger hover:opacity-70 disabled:opacity-30"
                  onClick={() => remove(r.id)}
                  disabled={disabled}
                >
                  ×
                </button>
              </li>
            )
          })}
        </ul>
      )}

      {/* Add-recipient form */}
      <div className="flex flex-col gap-1.5">
        <input
          type="text"
          placeholder="Name"
          aria-label="Recipient name"
          className="min-h-9 rounded-lg border border-edge-strong bg-paper px-2 text-[13px] text-ink outline-none focus-visible:ring-2 focus-visible:ring-brand-primary/40"
          value={name}
          onChange={(e) => setName(e.target.value)}
          disabled={disabled}
        />
        <input
          type="email"
          placeholder="Email"
          aria-label="Recipient email"
          className="min-h-9 rounded-lg border border-edge-strong bg-paper px-2 text-[13px] text-ink outline-none focus-visible:ring-2 focus-visible:ring-brand-primary/40"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              add()
            }
          }}
          disabled={disabled}
        />
        <button
          type="button"
          className={buttonClasses('secondary', 'sm', 'w-full')}
          onClick={add}
          disabled={disabled}
        >
          Add recipient
        </button>
        {error && (
          <p className="text-[11px] text-danger" role="alert">
            {error}
          </p>
        )}
      </div>

      {/* Signing order */}
      {recipients.length > 1 && (
        <fieldset className="flex flex-col gap-1" disabled={disabled}>
          <legend className="text-[12px] font-medium text-muted">Signing order</legend>
          <label className="flex items-center gap-2 text-[12px] text-ink">
            <input
              type="radio"
              name="signingOrder"
              checked={signingOrder === 'parallel'}
              onChange={() => onChangeSigningOrder('parallel')}
            />
            Parallel — everyone at once
          </label>
          <label className="flex items-center gap-2 text-[12px] text-ink">
            <input
              type="radio"
              name="signingOrder"
              checked={signingOrder === 'sequential'}
              onChange={() => onChangeSigningOrder('sequential')}
            />
            Sequential — in order
          </label>
        </fieldset>
      )}
    </div>
  )
}
