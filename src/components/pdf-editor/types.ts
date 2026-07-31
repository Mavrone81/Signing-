// Field type shared across the client PDF editor. `FlatField` is the exact
// normalized shape the editor emits to Save/Finalize (matches the server's
// `FlatField` in src/server/pdf/flatten.ts). `EditorField` adds a client-only
// stable id for React keys + selection; the id is stripped before emitting.

export type FieldType =
  | 'signature'
  | 'date'
  | 'text'
  // Phase 4a — more field types.
  | 'checkbox'
  | 'initials'
  | 'radio'
  | 'dropdown'

// Phase 4a: per-field config (persisted as `Field.options`, Prisma Json).
//  - dropdown: `choices` — the selectable options.
//  - radio:    `group` (shared key so only one option in the group is picked)
//              + `label` (this radio field's own option; the field renders
//              MARKED when `value === label`).
export interface FieldOptions {
  choices?: string[]
  group?: string
  label?: string
}

// Field-value semantics (stored in the string `Field.value`):
//  - signature / initials : a PNG data URL (`data:image…`)
//  - checkbox             : 'true' | 'false'
//  - radio                : the selected option's label (shared across the
//                           group); a radio field is "on" when value === its
//                           own options.label
//  - dropdown / text / date: the chosen option / typed text / ISO date
//
// Is a field considered "filled"? Optional fields (required === false) are
// ALWAYS treated as filled (they may be left blank). Shared by the editor's
// finalize gate, the signer's progress/finish gate, and server validation so
// the three never disagree.
export function isFieldFilled(
  type: FieldType,
  value: string,
  required = true,
): boolean {
  if (!required) return true
  if (type === 'signature' || type === 'initials') return value.startsWith('data:image')
  if (type === 'checkbox') return value === 'true'
  // radio / dropdown / text / date: a non-blank selection / entry.
  return value.trim() !== ''
}

// Rich formatting for a TEXT field. Persisted as `Field.style` (Prisma Json),
// rendered live in the editor, and drawn into the finalized PDF by flatten.ts.
// Only text fields carry a style; signature/date fields never do.
export interface TextStyle {
  fontFamily: string
  fontSize: number // points
  color: string // #rrggbb
  highlight: string | null // #rrggbb background, or null for none
  bold: boolean
  italic: boolean
  underline: boolean
}

// Default look for a newly-placed text field, and the fallback whenever a
// stored style is null/partial: Times New Roman, 10pt, near-black, no
// highlight, no bold/italic/underline.
export const DEFAULT_TEXT_STYLE: TextStyle = {
  fontFamily: 'Times New Roman',
  fontSize: 10,
  color: '#111827',
  highlight: null,
  bold: false,
  italic: false,
  underline: false,
}

export type FontGroup = 'serif' | 'sans' | 'mono'

export interface FontOption {
  family: string
  group: FontGroup
}

// Curated font list offered in the formatting panel. These are web-safe
// families the browser renders directly; on finalize each maps down to one of
// pdf-lib's three StandardFont families via `fontFamilyToStandard`.
export const FONT_FAMILIES: FontOption[] = [
  { family: 'Times New Roman', group: 'serif' },
  { family: 'Georgia', group: 'serif' },
  { family: 'Garamond', group: 'serif' },
  { family: 'Arial', group: 'sans' },
  { family: 'Helvetica', group: 'sans' },
  { family: 'Verdana', group: 'sans' },
  { family: 'Tahoma', group: 'sans' },
  { family: 'Calibri', group: 'sans' },
  { family: 'Trebuchet MS', group: 'sans' },
  { family: 'Courier New', group: 'mono' },
  { family: 'Consolas', group: 'mono' },
]

const SERIF_FAMILIES = new Set(['Times New Roman', 'Georgia', 'Garamond'])
const MONO_FAMILIES = new Set(['Courier New', 'Consolas'])

// Map a curated (or unknown) family down to one of pdf-lib's three
// StandardFont families. Serif families → serif, mono families → mono,
// everything else (incl. unknown) → sans.
export function fontFamilyToStandard(family: string): FontGroup {
  if (SERIF_FAMILIES.has(family)) return 'serif'
  if (MONO_FAMILIES.has(family)) return 'mono'
  return 'sans'
}

// A CSS font-family stack (family + a matching generic) for live editor
// rendering, so the browser falls back sensibly if a family isn't installed.
export function cssFontStack(family: string): string {
  const generic =
    fontFamilyToStandard(family) === 'serif'
      ? 'serif'
      : fontFamilyToStandard(family) === 'mono'
        ? 'monospace'
        : 'sans-serif'
  return `"${family}", ${generic}`
}

export interface FlatField {
  page: number // 1-based page number
  type: FieldType
  x: number // normalized 0..1, page-relative, origin top-left, y-down
  y: number
  w: number
  h: number
  value: string // text, ISO date, or (signature) a data: URL filled in Task 11
  style?: TextStyle // text fields only; undefined/null → DEFAULT_TEXT_STYLE
  // Phase 4a: whether the field must be filled before finalize/complete
  // (undefined → true, backward-compatible with pre-Phase-4a payloads).
  required?: boolean
  // Phase 4a: type-specific config (dropdown choices, radio group/label);
  // null/undefined for types that need none.
  options?: FieldOptions | null
  // Send-for-signature (Phase 2a): the Recipient this field is assigned to, or
  // null/undefined for the sender's own (self-sign) field.
  recipientId?: string | null
}

export interface EditorField extends FlatField {
  id: string
}

// A recipient the sender is preparing to send the document to. Held in the
// editor with a client id (uid) that is reused as the persisted Recipient.id,
// so field.recipientId references resolve without a name→id round-trip.
export interface EditorRecipient {
  id: string
  name: string
  email: string
}

export type SigningOrder = 'parallel' | 'sequential'

// Distinct tints, one per recipient (cycled by index). Each entry is a full set
// of Tailwind-independent inline colours so a field box can be coloured by who
// signs it. `swatch` is the solid dot; `border`/`bg` colour the field box.
export interface RecipientColor {
  swatch: string
  border: string
  bg: string
}

const RECIPIENT_PALETTE: RecipientColor[] = [
  { swatch: '#2563eb', border: '#2563eb', bg: 'rgba(37,99,235,0.10)' }, // blue
  { swatch: '#db2777', border: '#db2777', bg: 'rgba(219,39,119,0.10)' }, // pink
  { swatch: '#16a34a', border: '#16a34a', bg: 'rgba(22,163,74,0.10)' }, // green
  { swatch: '#d97706', border: '#d97706', bg: 'rgba(217,119,6,0.10)' }, // amber
  { swatch: '#7c3aed', border: '#7c3aed', bg: 'rgba(124,58,237,0.10)' }, // violet
  { swatch: '#0891b2', border: '#0891b2', bg: 'rgba(8,145,178,0.10)' }, // cyan
  { swatch: '#dc2626', border: '#dc2626', bg: 'rgba(220,38,38,0.10)' }, // red
  { swatch: '#4d7c0f', border: '#4d7c0f', bg: 'rgba(77,124,15,0.10)' }, // lime
]

// Colour for the recipient at position `index` in the recipient list. Cycles
// through the palette so any number of recipients gets a stable-ish tint.
export function recipientColor(index: number): RecipientColor {
  return RECIPIENT_PALETTE[((index % RECIPIENT_PALETTE.length) + RECIPIENT_PALETTE.length) % RECIPIENT_PALETTE.length]
}
