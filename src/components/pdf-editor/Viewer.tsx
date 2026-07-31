'use client'

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import * as pdfjs from 'pdfjs-dist'
import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist'
import type { PageSize } from './FieldLayer'

// Worker served locally from public/ (copied out of node_modules by
// scripts/copy-pdf-worker.mjs on prebuild) — the app runs offline, so no CDN.
pdfjs.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs'

interface ViewerProps {
  // Raw PDF bytes. Owned by the caller (edit page fetches + decrypts once).
  data: ArrayBuffer
  // Per-page overlay (the FieldLayer). Called with the 1-based page number and
  // the page's rendered CSS pixel size once the page has painted.
  renderPageOverlay?: (pageNumber: number, size: PageSize) => ReactNode
}

export function Viewer({ data, renderPageOverlay }: ViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null)
  const [numPages, setNumPages] = useState(0)
  const [width, setWidth] = useState(0)
  const [error, setError] = useState<string | null>(null)

  // Track container width so pages render crisp at the available width.
  useLayoutEffect(() => {
    const el = containerRef.current
    if (!el) return
    const update = () => setWidth(el.clientWidth)
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Load the document once per `data` reference.
  useEffect(() => {
    let cancelled = false
    setError(null)
    // pdf.js transfers/detaches the buffer it's given; hand it a copy so the
    // caller's ArrayBuffer stays usable across re-loads.
    const task = pdfjs.getDocument({ data: data.slice(0) })
    task.promise
      .then((loaded) => {
        if (cancelled) return
        setPdf(loaded)
        setNumPages(loaded.numPages)
      })
      .catch(() => {
        if (!cancelled) setError('Could not load this PDF.')
      })
    return () => {
      cancelled = true
      // Destroys the loading task, its worker, and the document proxy.
      task.destroy()
    }
  }, [data])

  if (error) {
    return (
      <p className="py-10 text-center text-[14px] text-danger" role="alert">
        {error}
      </p>
    )
  }

  return (
    <div ref={containerRef} className="flex flex-col items-center gap-6">
      {pdf &&
        width > 0 &&
        Array.from({ length: numPages }, (_, i) => i + 1).map((pageNumber) => (
          <PdfPage
            key={pageNumber}
            pdf={pdf}
            pageNumber={pageNumber}
            width={width}
            renderPageOverlay={renderPageOverlay}
          />
        ))}
      {!pdf && !error && (
        <p className="py-10 text-center text-[14px] text-muted">Loading document…</p>
      )}
    </div>
  )
}

function PdfPage({
  pdf,
  pageNumber,
  width,
  renderPageOverlay,
}: {
  pdf: PDFDocumentProxy
  pageNumber: number
  width: number
  renderPageOverlay?: (pageNumber: number, size: PageSize) => ReactNode
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [size, setSize] = useState<PageSize | null>(null)

  useEffect(() => {
    let cancelled = false
    let task: RenderTask | null = null
    ;(async () => {
      const page = await pdf.getPage(pageNumber)
      const base = page.getViewport({ scale: 1 })
      const scale = width / base.width
      const viewport = page.getViewport({ scale })
      const canvas = canvasRef.current
      if (!canvas || cancelled) return

      // Render at devicePixelRatio for crisp text, but lay out at CSS px.
      const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1
      canvas.width = Math.floor(viewport.width * dpr)
      canvas.height = Math.floor(viewport.height * dpr)
      canvas.style.width = `${viewport.width}px`
      canvas.style.height = `${viewport.height}px`

      task = page.render({
        canvas,
        viewport,
        transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
      })
      try {
        await task.promise
        if (!cancelled) setSize({ width: viewport.width, height: viewport.height })
      } catch {
        // render cancelled (width change / unmount) — ignore
      }
    })()
    return () => {
      cancelled = true
      task?.cancel()
    }
  }, [pdf, pageNumber, width])

  return (
    <div
      className="relative bg-paper shadow-sm ring-1 ring-edge"
      style={size ? { width: size.width, height: size.height } : undefined}
    >
      <canvas ref={canvasRef} className="block" />
      {size && renderPageOverlay?.(pageNumber, size)}
    </div>
  )
}
