'use client'

import { useEffect, useRef, useState, type ChangeEvent } from 'react'
import { buttonClasses } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { isSupportedSignatureImage } from '@/lib/signature-file'
import { SignaturePad } from '../signature-pad'

interface SignatureModalProps {
  open: boolean
  onClose: () => void
  onConfirm: (pngDataUrl: string) => void
}

type Tab = 'draw' | 'type' | 'upload'

const TABS: { id: Tab; label: string }[] = [
  { id: 'draw', label: 'Draw' },
  { id: 'type', label: 'Type' },
  { id: 'upload', label: 'Upload' },
]

// Script-ish font stack for the Type tab — no cursive webfont is loaded in
// this app (only Poppins/IBM Plex Mono, see globals.css), so we fall back to
// whatever cursive face the OS provides via the generic `cursive` family.
const TYPED_FONT_STACK = '"Segoe Script", "Brush Script MT", "Lucida Handwriting", cursive'
const INK_COLOR = '#1a1f2b'
const MAX_UPLOAD_DIMENSION = 1000

// Signature capture modal: Draw (canvas pad) / Type (rendered script text) /
// Upload (re-exported as PNG). Always resolves to a `data:image/png;...`
// URL on confirm — the server flatten step
// (src/server/pdf/flatten.ts) only embeds a signature value as an image when
// it starts with `data:image`; anything else gets drawn as raw text.
export function SignatureModal({ open, onClose, onConfirm }: SignatureModalProps) {
  const [tab, setTab] = useState<Tab>('draw')
  const [pending, setPending] = useState<string | null>(null)
  const [typedName, setTypedName] = useState('')
  const [uploadError, setUploadError] = useState<string | null>(null)
  const typedCanvasRef = useRef<HTMLCanvasElement>(null)
  // Tracks the active tab for async callbacks (e.g. handleUpload) whose
  // closures would otherwise read a stale `tab` from render time.
  const tabRef = useRef<Tab>(tab)

  useEffect(() => {
    tabRef.current = tab
  }, [tab])

  // Clean slate every time the modal opens.
  useEffect(() => {
    if (!open) return
    setTab('draw')
    setPending(null)
    setTypedName('')
    setUploadError(null)
  }, [open])

  useEffect(() => {
    if (!open) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  // Re-render the typed name onto the preview canvas whenever it changes
  // while the Type tab is active.
  useEffect(() => {
    if (!open || tab !== 'type') return
    const canvas = typedCanvasRef.current
    if (!canvas) return
    const name = typedName.trim()
    if (!name) {
      setPending(null)
      const ctx = canvas.getContext('2d')
      if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height)
      return
    }
    setPending(renderTypedSignature(canvas, name))
  }, [open, tab, typedName])

  if (!open) return null

  function switchTab(next: Tab) {
    if (next === tab) return
    setTab(next)
    setPending(null)
    setTypedName('')
    setUploadError(null)
  }

  async function handleUpload(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    if (!isSupportedSignatureImage(file)) {
      setUploadError('Please choose a PNG or JPG image.')
      setPending(null)
      return
    }
    setUploadError(null)
    try {
      const dataUrl = await fileToPngDataUrl(file)
      // The user may have switched to Draw/Type while this was decoding —
      // don't revive a discarded Upload image onto a different tab.
      if (tabRef.current !== 'upload') return
      setPending(dataUrl)
    } catch {
      if (tabRef.current !== 'upload') return
      setUploadError('Could not read that image. Please try another file.')
    }
  }

  function confirm() {
    if (!pending) return
    onConfirm(pending)
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4"
      onClick={onClose}
    >
      <Card
        role="dialog"
        aria-modal="true"
        aria-label="Add signature"
        className="w-full max-w-lg p-4 sm:p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="mb-3 text-[15px] font-semibold text-ink">Add your signature</h2>

        <div className="mb-4 flex gap-2" role="tablist" aria-label="Signature method">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              className={buttonClasses(tab === t.id ? 'primary' : 'secondary', 'md', 'flex-1')}
              onClick={() => switchTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>

        {tab === 'draw' && <SignaturePad key="draw" onChange={setPending} />}

        {tab === 'type' && (
          <div key="type">
            <input
              type="text"
              autoFocus
              value={typedName}
              onChange={(e) => setTypedName(e.target.value)}
              placeholder="Type your name"
              aria-label="Type your name"
              className="h-11 w-full rounded-lg border border-edge-strong bg-paper px-3 text-[14px] text-ink outline-none focus-visible:ring-2 focus-visible:ring-brand-primary/40"
            />
            <div className="mt-3 overflow-hidden rounded-lg border border-edge bg-white">
              <canvas ref={typedCanvasRef} className="h-32 w-full" aria-hidden="true" />
            </div>
            <button
              type="button"
              onClick={() => setTypedName('')}
              className={buttonClasses('secondary', 'sm', 'mt-2')}
            >
              Clear
            </button>
          </div>
        )}

        {tab === 'upload' && (
          <div key="upload">
            <input
              type="file"
              autoFocus
              accept="image/png,image/jpeg"
              aria-label="Upload signature image"
              onChange={handleUpload}
              className="block w-full text-[13px] text-muted file:mr-3 file:min-h-11 file:rounded-lg file:border file:border-edge-strong file:bg-paper file:px-4 file:text-sm file:font-medium file:text-ink hover:file:bg-shell"
            />
            {uploadError && (
              <p className="mt-2 text-[13px] text-danger" role="alert">
                {uploadError}
              </p>
            )}
            {pending && (
              <div className="mt-3 flex justify-center rounded-lg border border-edge bg-white p-2">
                {/* eslint-disable-next-line @next/next/no-img-element -- data: URL preview, not a Next-optimizable asset */}
                <img src={pending} alt="Uploaded signature preview" className="max-h-32 object-contain" />
              </div>
            )}
            {pending && (
              <button
                type="button"
                onClick={() => setPending(null)}
                className={buttonClasses('secondary', 'sm', 'mt-2')}
              >
                Clear
              </button>
            )}
          </div>
        )}

        <div className="mt-5 flex justify-end gap-2">
          <button type="button" className={buttonClasses('secondary', 'md')} onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className={buttonClasses('primary', 'md')}
            onClick={confirm}
            disabled={!pending}
          >
            Confirm
          </button>
        </div>
      </Card>
    </div>
  )
}

// Renders `name` in a script/cursive style onto `canvas`, hi-dpi aware, and
// returns the resulting PNG data URL. Background is left transparent.
function renderTypedSignature(canvas: HTMLCanvasElement, name: string): string {
  const ratio = window.devicePixelRatio || 1
  const rect = canvas.getBoundingClientRect()
  const width = rect.width || 320
  const height = rect.height || 128
  canvas.width = Math.round(width * ratio)
  canvas.height = Math.round(height * ratio)
  const ctx = canvas.getContext('2d')!
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0)
  ctx.clearRect(0, 0, width, height)
  ctx.fillStyle = INK_COLOR
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'

  // Shrink the font until the name fits with some side padding.
  const maxWidth = width * 0.9
  let fontSize = Math.min(64, height * 0.6)
  ctx.font = `italic 400 ${fontSize}px ${TYPED_FONT_STACK}`
  while (fontSize > 16 && ctx.measureText(name).width > maxWidth) {
    fontSize -= 2
    ctx.font = `italic 400 ${fontSize}px ${TYPED_FONT_STACK}`
  }

  ctx.fillText(name, width / 2, height / 2)
  return canvas.toDataURL('image/png')
}

// Loads `file`, draws it onto a canvas at (at most) MAX_UPLOAD_DIMENSION,
// and re-exports as PNG so the stored value is always image/png. A JPG
// source has no transparency — that's expected and fine.
function fileToPngDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => {
      try {
        const scale = Math.min(1, MAX_UPLOAD_DIMENSION / Math.max(img.naturalWidth, img.naturalHeight))
        const w = Math.max(1, Math.round(img.naturalWidth * scale))
        const h = Math.max(1, Math.round(img.naturalHeight * scale))
        const canvas = document.createElement('canvas')
        canvas.width = w
        canvas.height = h
        const ctx = canvas.getContext('2d')!
        ctx.drawImage(img, 0, 0, w, h)
        resolve(canvas.toDataURL('image/png'))
      } catch (err) {
        reject(err instanceof Error ? err : new Error('image draw failed'))
      } finally {
        URL.revokeObjectURL(url)
      }
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('image load failed'))
    }
    img.src = url
  })
}
