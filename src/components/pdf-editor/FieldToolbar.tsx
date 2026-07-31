'use client'

import { buttonClasses } from '@/components/ui/Button'
import type { FieldType } from './types'

interface FieldToolbarProps {
  activeType: FieldType | null
  onPick: (type: FieldType) => void
  disabled?: boolean
}

// Grouped so related tools sit together: signing marks, then plain content,
// then the choice inputs. Order within the flat list drives the sidebar.
const OPTIONS: { type: FieldType; label: string }[] = [
  { type: 'signature', label: 'Signature' },
  { type: 'initials', label: 'Initials' },
  { type: 'date', label: 'Date' },
  { type: 'text', label: 'Text' },
  { type: 'checkbox', label: 'Checkbox' },
  { type: 'dropdown', label: 'Dropdown' },
  { type: 'radio', label: 'Radio' },
]

// Field-placement sidebar. Renders as a vertical stack of pick buttons — the
// active pick (if any) is highlighted, and clicking it again deselects
// (toggling is handled by the parent's onPick). Editor decides layout: a left
// column on desktop, a horizontal row up top on mobile (this component only
// switches its own internal flex direction; the surrounding placement is the
// caller's job).
export function FieldToolbar({ activeType, onPick, disabled }: FieldToolbarProps) {
  return (
    <div
      className="flex flex-row gap-2 rounded-xl border border-edge bg-paper p-3 shadow-sm md:flex-col"
      role="toolbar"
      aria-label="Add fields"
    >
      <span className="hidden text-[13px] font-medium text-muted md:block">Add field</span>
      {OPTIONS.map(({ type, label }) => {
        const active = type === activeType
        return (
          <button
            key={type}
            type="button"
            className={buttonClasses(active ? 'primary' : 'secondary', 'md', 'flex-1 md:flex-none md:w-full')}
            aria-pressed={active}
            onClick={() => onPick(type)}
            disabled={disabled}
          >
            {label}
          </button>
        )
      })}
      {activeType && (
        <p className="text-[12px] text-muted md:mt-1">Click on the document to place the field.</p>
      )}
    </div>
  )
}
