'use client'

import { buttonClasses } from '@/components/ui/Button'
import type { EditorField, FieldOptions } from './types'

interface FieldConfigPanelProps {
  field: EditorField
  onChange: (patch: Partial<EditorField>) => void
}

// Per-field configuration shown in the editor sidebar for the selected field:
// a Required toggle (every field type) plus, for dropdown/radio, an options
// editor. Text-specific formatting lives in the separate TextFormatPanel.
export function FieldConfigPanel({ field, onChange }: FieldConfigPanelProps) {
  const required = field.required ?? true
  const opts: FieldOptions = field.options ?? {}

  const setOptions = (patch: Partial<FieldOptions>) =>
    onChange({ options: { ...opts, ...patch } })

  return (
    <div
      className="mt-3 flex flex-col gap-3 rounded-xl border border-edge bg-paper p-3 shadow-sm"
      role="group"
      aria-label="Field settings"
    >
      <span className="text-[13px] font-medium text-muted">Field settings</span>

      {/* Required toggle — every field type. */}
      <label className="flex items-center justify-between gap-2 text-[12px] font-medium text-ink">
        <span>
          Required
          <span className="ml-1 font-normal text-muted">
            {required ? '(must be filled)' : '(optional)'}
          </span>
        </span>
        <button
          type="button"
          role="switch"
          aria-checked={required}
          aria-label="Required"
          onClick={() => onChange({ required: !required })}
          className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${
            required ? 'bg-brand-primary' : 'bg-shell'
          }`}
        >
          <span
            className={`inline-block h-5 w-5 transform rounded-full bg-paper shadow transition-transform ${
              required ? 'translate-x-5' : 'translate-x-0.5'
            }`}
          />
        </button>
      </label>

      {/* Dropdown choices editor. */}
      {field.type === 'dropdown' && (
        <ChoicesEditor
          choices={opts.choices ?? []}
          onChange={(choices) => setOptions({ choices })}
        />
      )}

      {/* Radio group + this option's label. */}
      {field.type === 'radio' && (
        <>
          <label className="flex flex-col gap-1 text-[12px] font-medium text-muted">
            Group
            <input
              type="text"
              aria-label="Radio group"
              className="min-h-11 rounded-lg border border-edge-strong bg-paper px-2 text-[13px] text-ink outline-none focus-visible:ring-2 focus-visible:ring-brand-primary/40"
              value={opts.group ?? ''}
              placeholder="group-1"
              onChange={(e) => setOptions({ group: e.target.value })}
            />
          </label>
          <label className="flex flex-col gap-1 text-[12px] font-medium text-muted">
            This option&apos;s label
            <input
              type="text"
              aria-label="Radio option label"
              className="min-h-11 rounded-lg border border-edge-strong bg-paper px-2 text-[13px] text-ink outline-none focus-visible:ring-2 focus-visible:ring-brand-primary/40"
              value={opts.label ?? ''}
              placeholder="Option"
              onChange={(e) => setOptions({ label: e.target.value })}
            />
          </label>
          <p className="text-[11px] text-muted">
            Give radios the same Group so only one can be selected.
          </p>
        </>
      )}
    </div>
  )
}

// Add / remove / rename the selectable choices of a dropdown field.
function ChoicesEditor({
  choices,
  onChange,
}: {
  choices: string[]
  onChange: (choices: string[]) => void
}) {
  const setAt = (i: number, v: string) => onChange(choices.map((c, j) => (j === i ? v : c)))
  const removeAt = (i: number) => onChange(choices.filter((_, j) => j !== i))
  const add = () => onChange([...choices, `Option ${choices.length + 1}`])

  return (
    <div className="flex flex-col gap-2" role="group" aria-label="Dropdown options">
      <span className="text-[12px] font-medium text-muted">Options</span>
      {choices.map((c, i) => (
        <div key={i} className="flex items-center gap-2">
          <input
            type="text"
            aria-label={`Option ${i + 1}`}
            className="min-h-11 min-w-0 flex-1 rounded-lg border border-edge-strong bg-paper px-2 text-[13px] text-ink outline-none focus-visible:ring-2 focus-visible:ring-brand-primary/40"
            value={c}
            onChange={(e) => setAt(i, e.target.value)}
          />
          <button
            type="button"
            aria-label={`Remove option ${i + 1}`}
            className={buttonClasses('secondary', 'sm')}
            onClick={() => removeAt(i)}
            disabled={choices.length <= 1}
          >
            ×
          </button>
        </div>
      ))}
      <button type="button" className={buttonClasses('secondary', 'sm')} onClick={add}>
        Add option
      </button>
    </div>
  )
}
