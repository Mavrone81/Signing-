'use client'

import { useState } from 'react'
import { saveBranding } from './actions'

const DEFAULT_COLOR = '#b8860b'

// Org branding form with a LIVE preview of the signing header. Brand name +
// colour update the preview as you type; a newly-chosen logo file is previewed
// client-side via a blob URL before it's ever uploaded.
export function BrandingForm({
  orgName,
  initialBrandName,
  initialBrandColor,
  initialLogo,
}: {
  orgName: string
  initialBrandName: string
  initialBrandColor: string | null
  initialLogo: string | null
}) {
  const [name, setName] = useState(initialBrandName)
  const [color, setColor] = useState(initialBrandColor ?? DEFAULT_COLOR)
  // Preview URL for a freshly-selected file (object URL), else the stored logo.
  const [logoPreview, setLogoPreview] = useState<string | null>(initialLogo)
  const [remove, setRemove] = useState(false)

  const displayName = name.trim() || orgName

  function onPickLogo(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setRemove(false)
    setLogoPreview(URL.createObjectURL(file))
  }

  function onRemove() {
    setRemove(true)
    setLogoPreview(null)
  }

  const fieldClass =
    'w-full rounded-lg border border-edge-strong bg-paper px-3 py-2 text-[14px] text-ink outline-none focus:border-brand-primary focus:ring-1 focus:ring-brand-primary'

  return (
    <form action={saveBranding} className="mt-6 grid gap-8 lg:grid-cols-[1fr_320px]">
      <div className="space-y-5">
        <div>
          <label className="mb-1.5 block text-[13px] font-medium text-ink">Brand name</label>
          <input
            name="brandName"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={orgName}
            maxLength={120}
            autoComplete="off"
            className={fieldClass}
          />
          <p className="mt-1 text-[12px] text-muted">
            Shown to your recipients and in notification emails. Defaults to{' '}
            <span className="font-medium text-ink">{orgName}</span> when left blank.
          </p>
        </div>

        <div>
          <label className="mb-1.5 block text-[13px] font-medium text-ink">Brand colour</label>
          <div className="flex items-center gap-3">
            <input
              name="brandColor"
              type="color"
              value={color}
              onChange={(e) => setColor(e.target.value)}
              className="h-10 w-14 cursor-pointer rounded-lg border border-edge-strong bg-paper p-1"
              aria-label="Brand colour"
            />
            <code className="text-[13px] text-muted">{color}</code>
            <button
              type="button"
              onClick={() => setColor(DEFAULT_COLOR)}
              className="text-[12px] text-brand-primary hover:underline"
            >
              Reset to default
            </button>
          </div>
        </div>

        <div>
          <label className="mb-1.5 block text-[13px] font-medium text-ink">Logo</label>
          <input
            name="logo"
            type="file"
            accept="image/png,image/jpeg,image/svg+xml"
            onChange={onPickLogo}
            className="block w-full text-[13px] text-ink file:mr-3 file:rounded-lg file:border-0 file:bg-brand-primary file:px-3 file:py-2 file:text-[13px] file:font-medium file:text-white hover:file:bg-brand-primary-dark"
          />
          <p className="mt-1 text-[12px] text-muted">PNG, JPG, or SVG, up to 1&nbsp;MB.</p>
          {logoPreview && (
            <button
              type="button"
              onClick={onRemove}
              className="mt-2 text-[12px] text-danger hover:underline"
            >
              Remove logo
            </button>
          )}
          {/* Signals the server action to clear the stored logo. */}
          <input type="hidden" name="removeLogo" value={remove ? '1' : ''} />
        </div>

        <button
          type="submit"
          className="rounded-lg bg-brand-primary px-4 py-2.5 text-[14px] font-medium text-white transition-colors hover:bg-brand-primary-dark"
        >
          Save branding
        </button>
      </div>

      {/* Live preview of the signing header the recipient will see. */}
      <div>
        <p className="mb-2 text-[12px] font-medium uppercase tracking-wide text-muted">
          Signing header preview
        </p>
        <div
          className="rounded-xl border border-edge bg-paper p-5"
          style={{ ['--brand-primary' as string]: color }}
        >
          <div className="mb-4 flex items-center gap-2.5">
            {logoPreview ? (
              // eslint-disable-next-line @next/next/no-img-element -- preview blob/data URI
              <img src={logoPreview} alt={displayName} className="h-8 w-auto max-w-[160px] object-contain" />
            ) : (
              <span className="text-[16px] font-semibold tracking-[-0.02em] text-brand-primary">
                {displayName}
              </span>
            )}
          </div>
          <p className="text-[11px] font-medium uppercase tracking-wide text-muted">Signature request</p>
          <h3 className="mt-1 text-[16px] font-semibold text-ink">Agreement.pdf</h3>
          <div className="mt-4 h-1.5 w-full overflow-hidden rounded-full bg-shell">
            <div className="h-full w-2/3 rounded-full bg-brand-primary" />
          </div>
          <div className="mt-4">
            <span className="inline-block rounded-lg bg-brand-primary px-4 py-2 text-[13px] font-medium text-white">
              Finish signing
            </span>
          </div>
        </div>
      </div>
    </form>
  )
}
