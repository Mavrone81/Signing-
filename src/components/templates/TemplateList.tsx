'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { Card } from '@/components/ui/Card'
import { buttonClasses } from '@/components/ui/Button'
import { formatDateSGT } from '@/lib/format'

export interface TemplateSummary {
  id: string
  name: string
  description: string | null
  pageCount: number
  fieldCount: number
  roleCount: number
  createdAt: string
  // Whether the current viewer may delete this template (creator or org admin).
  canDelete: boolean
}

// Client list for the Templates page: "Use" creates a draft document from the
// template and routes to its editor; "Delete" removes it (creator/admins only).
export function TemplateList({ templates }: { templates: TemplateSummary[] }) {
  const router = useRouter()
  const [items, setItems] = useState(templates)
  // Per-template transient status ('using' | 'deleting' | an error message).
  const [busy, setBusy] = useState<Record<string, string>>({})

  const use = async (id: string) => {
    setBusy((b) => ({ ...b, [id]: 'using' }))
    try {
      const res = await fetch(`/api/templates/${id}/use`, { method: 'POST' })
      if (!res.ok) {
        setBusy((b) => ({ ...b, [id]: `Could not create document (${res.status}).` }))
        return
      }
      const body = (await res.json()) as { documentId: string }
      router.push(`/documents/${body.documentId}/edit`)
    } catch {
      setBusy((b) => ({ ...b, [id]: 'Network error. Please try again.' }))
    }
  }

  const remove = async (id: string) => {
    if (!window.confirm('Delete this template? This cannot be undone.')) return
    setBusy((b) => ({ ...b, [id]: 'deleting' }))
    try {
      const res = await fetch(`/api/templates/${id}`, { method: 'DELETE' })
      if (!res.ok) {
        setBusy((b) => ({ ...b, [id]: `Could not delete (${res.status}).` }))
        return
      }
      setItems((list) => list.filter((t) => t.id !== id))
    } catch {
      setBusy((b) => ({ ...b, [id]: 'Network error. Please try again.' }))
    }
  }

  if (items.length === 0) {
    return (
      <Card className="flex flex-col items-center gap-1 px-6 py-12 text-center">
        <p className="text-[14px] font-medium text-ink">No templates yet</p>
        <p className="text-[13px] text-muted">
          Open a document in the editor and choose “Save as template” to create one.
        </p>
      </Card>
    )
  }

  return (
    <ul className="flex flex-col gap-3">
      {items.map((t) => {
        const state = busy[t.id]
        const working = state === 'using' || state === 'deleting'
        const error = state && state !== 'using' && state !== 'deleting' ? state : null
        return (
          <li key={t.id}>
            <Card className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <p className="truncate text-[14px] font-medium text-ink">{t.name}</p>
                {t.description && (
                  <p className="mt-0.5 truncate text-[13px] text-muted">{t.description}</p>
                )}
                <p className="mt-1 text-[12px] text-muted">
                  Created {formatDateSGT(new Date(t.createdAt))} · {t.pageCount} page
                  {t.pageCount === 1 ? '' : 's'} · {t.fieldCount} field
                  {t.fieldCount === 1 ? '' : 's'} · {t.roleCount} recipient
                  {t.roleCount === 1 ? '' : 's'}
                </p>
                {error && (
                  <p className="mt-1 text-[12px] text-danger" role="alert">
                    {error}
                  </p>
                )}
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  className={buttonClasses('primary', 'sm')}
                  onClick={() => use(t.id)}
                  disabled={working}
                >
                  {state === 'using' ? 'Creating…' : 'Use'}
                </button>
                {t.canDelete && (
                  <button
                    type="button"
                    className={buttonClasses('secondary', 'sm')}
                    onClick={() => remove(t.id)}
                    disabled={working}
                  >
                    {state === 'deleting' ? 'Deleting…' : 'Delete'}
                  </button>
                )}
              </div>
            </Card>
          </li>
        )
      })}
    </ul>
  )
}
