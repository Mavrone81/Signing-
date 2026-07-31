'use client'

import { buttonClasses } from '@/components/ui/Button'
import { FONT_FAMILIES, cssFontStack, type TextStyle } from './types'

interface TextFormatPanelProps {
  style: TextStyle
  onChange: (patch: Partial<TextStyle>) => void
}

// Default swatch shown when turning highlight on (a soft yellow).
const HIGHLIGHT_DEFAULT = '#fff176'

// Left-sidebar panel shown when the selected field is a text field. Each
// control patches a single style property via `onChange`; the parent merges
// it into the field's style.
export function TextFormatPanel({ style, onChange }: TextFormatPanelProps) {
  const toggleClasses = (active: boolean) =>
    buttonClasses(active ? 'primary' : 'secondary', 'sm', 'flex-1 md:flex-none')

  return (
    <div
      className="mt-3 flex flex-col gap-3 rounded-xl border border-edge bg-paper p-3 shadow-sm"
      role="group"
      aria-label="Text formatting"
    >
      <span className="text-[13px] font-medium text-muted">Text formatting</span>

      {/* Font family */}
      <label className="flex flex-col gap-1 text-[12px] font-medium text-muted">
        Font
        <select
          className="min-h-11 rounded-lg border border-edge-strong bg-paper px-2 text-[13px] text-ink outline-none focus-visible:ring-2 focus-visible:ring-brand-primary/40"
          value={style.fontFamily}
          onChange={(e) => onChange({ fontFamily: e.target.value })}
          style={{ fontFamily: cssFontStack(style.fontFamily) }}
        >
          {FONT_FAMILIES.map((f) => (
            <option key={f.family} value={f.family} style={{ fontFamily: cssFontStack(f.family) }}>
              {f.family}
            </option>
          ))}
        </select>
      </label>

      {/* Font size */}
      <label className="flex flex-col gap-1 text-[12px] font-medium text-muted">
        Size (pt)
        <input
          type="number"
          min={4}
          max={96}
          step={1}
          className="min-h-11 rounded-lg border border-edge-strong bg-paper px-2 text-[13px] text-ink outline-none focus-visible:ring-2 focus-visible:ring-brand-primary/40"
          value={style.fontSize}
          onChange={(e) => {
            const n = Number(e.target.value)
            if (!Number.isFinite(n)) return
            onChange({ fontSize: Math.min(96, Math.max(4, n)) })
          }}
        />
      </label>

      {/* Colour */}
      <label className="flex items-center justify-between gap-2 text-[12px] font-medium text-muted">
        Colour
        <input
          type="color"
          aria-label="Text colour"
          className="h-11 w-14 cursor-pointer rounded-lg border border-edge-strong bg-paper p-1"
          value={style.color}
          onChange={(e) => onChange({ color: e.target.value })}
        />
      </label>

      {/* Highlight */}
      <div className="flex items-center justify-between gap-2 text-[12px] font-medium text-muted">
        <span>Highlight</span>
        <div className="flex items-center gap-2">
          <input
            type="color"
            aria-label="Highlight colour"
            className="h-11 w-14 cursor-pointer rounded-lg border border-edge-strong bg-paper p-1"
            value={style.highlight ?? HIGHLIGHT_DEFAULT}
            onChange={(e) => onChange({ highlight: e.target.value })}
          />
          <button
            type="button"
            aria-pressed={style.highlight === null}
            className={buttonClasses(style.highlight === null ? 'primary' : 'secondary', 'sm')}
            onClick={() => onChange({ highlight: null })}
          >
            None
          </button>
        </div>
      </div>

      {/* Bold / Italic / Underline */}
      <div className="flex gap-2" role="group" aria-label="Text style">
        <button
          type="button"
          aria-pressed={style.bold}
          aria-label="Bold"
          className={toggleClasses(style.bold)}
          onClick={() => onChange({ bold: !style.bold })}
        >
          <span className="font-bold">B</span>
        </button>
        <button
          type="button"
          aria-pressed={style.italic}
          aria-label="Italic"
          className={toggleClasses(style.italic)}
          onClick={() => onChange({ italic: !style.italic })}
        >
          <span className="italic">I</span>
        </button>
        <button
          type="button"
          aria-pressed={style.underline}
          aria-label="Underline"
          className={toggleClasses(style.underline)}
          onClick={() => onChange({ underline: !style.underline })}
        >
          <span className="underline">U</span>
        </button>
      </div>
    </div>
  )
}
