'use client'

import { startTransition, useActionState, useRef, useState } from 'react'
import { createEnvelopeAction, type CreateEnvelopeState } from './actions'

const fieldClass =
  'w-full rounded-lg border border-edge-strong bg-paper px-3 py-2 text-[14px] text-ink outline-none focus:border-brand-primary focus:ring-1 focus:ring-brand-primary'

// Create an envelope from existing drafts and/or several new PDFs. New files are
// uploaded one by one through the normal upload route first (same validation
// as the Documents page), then the envelope is created with all of them.
export function NewEnvelopeForm({ drafts }: { drafts: { id: string; name: string }[] }) {
  const [state, action, pending] = useActionState<CreateEnvelopeState, FormData>(createEnvelopeAction, { status: 'idle' })
  const [uploading, setUploading] = useState<string | null>(null)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const files = useRef<HTMLInputElement | null>(null)

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setUploadError(null)
    const formData = new FormData(e.currentTarget)
    formData.delete('files')
    const picked = Array.from(files.current?.files ?? [])
    for (const [i, f] of picked.entries()) {
      setUploading(`Uploading ${i + 1} of ${picked.length}: ${f.name}`)
      const body = new FormData()
      body.append('file', f)
      const res = await fetch('/api/documents', { method: 'POST', body }).catch(() => null)
      if (!res || !res.ok) {
        const err = res ? ((await res.json().catch(() => ({}))) as { error?: string }).error : null
        setUploading(null)
        setUploadError(
          `${f.name} could not be uploaded${err === 'INVALID_PDF' ? ' (not a readable PDF)' : err === 'TOO_LARGE' ? ' (too large)' : ''}. Nothing was created; files uploaded before it are on your Documents page.`,
        )
        return
      }
      formData.append('documentId', ((await res.json()) as { id: string }).id)
    }
    setUploading(null)
    if (formData.getAll('documentId').length === 0) {
      setUploadError('Choose at least one document or upload a PDF.')
      return
    }
    startTransition(() => action(formData))
  }

  const busy = pending || uploading !== null

  return (
    <form onSubmit={submit} className="space-y-4 rounded-xl border border-edge bg-paper p-5">
      <h2 className="text-[15px] font-semibold text-ink">New envelope</h2>
      <div>
        <label htmlFor="env-name" className="mb-1.5 block text-[13px] font-medium text-ink">
          Name
        </label>
        <input id="env-name" name="name" type="text" required maxLength={200} placeholder="e.g. New starter pack" className={fieldClass} />
      </div>

      <div>
        <label htmlFor="env-files" className="mb-1.5 block text-[13px] font-medium text-ink">
          Upload PDFs
        </label>
        <input
          id="env-files"
          ref={files}
          name="files"
          type="file"
          accept="application/pdf,.pdf"
          multiple
          className="block w-full text-[13px] text-ink file:mr-3 file:rounded-lg file:border-0 file:bg-shell file:px-3 file:py-2 file:text-[13px] file:font-medium file:text-ink"
        />
      </div>

      {drafts.length > 0 && (
        <fieldset>
          <legend className="mb-1.5 text-[13px] font-medium text-ink">…and/or add your drafts</legend>
          <div className="max-h-56 space-y-1.5 overflow-y-auto rounded-lg border border-edge p-3">
            {drafts.map((d) => (
              <label key={d.id} className="flex items-center gap-2.5 text-[13px] text-ink">
                <input type="checkbox" name="documentId" value={d.id} className="h-4 w-4 rounded border-edge-strong text-brand-primary" />
                <span className="truncate">{d.name}</span>
              </label>
            ))}
          </div>
        </fieldset>
      )}

      {uploading && (
        <p role="status" className="text-[13px] text-muted">
          {uploading}
        </p>
      )}
      {(uploadError || state.status === 'error') && (
        <p role="alert" className="text-[13px] text-danger">
          {uploadError ?? (state.status === 'error' ? state.message : '')}
        </p>
      )}

      <button
        type="submit"
        disabled={busy}
        className="rounded-lg bg-brand-primary px-4 py-2.5 text-[14px] font-medium text-white hover:bg-brand-primary-dark disabled:opacity-60"
      >
        {pending ? 'Creating…' : 'Create envelope'}
      </button>
    </form>
  )
}
