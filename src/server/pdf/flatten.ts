import { PDFDocument, StandardFonts, rgb, type PDFFont } from 'pdf-lib'
import fontkit from '@pdf-lib/fontkit'
import { normToPdfRect } from '@/lib/coords'
import { embedNotoRegular, sanitizeForFont } from './font'
import {
  DEFAULT_TEXT_STYLE,
  fontFamilyToStandard,
  type FieldOptions,
  type FieldType,
  type TextStyle,
} from '@/components/pdf-editor/types'

// Re-export so server-side callers (actions.ts) can pull the text-style type +
// default from the same place they import FlatField, without reaching into a
// client component module directly.
export { DEFAULT_TEXT_STYLE, type TextStyle }

export type FlatField = {
  page: number
  type: FieldType
  x: number
  y: number
  w: number
  h: number
  value: string
  // Rich formatting for text fields (null/undefined → DEFAULT_TEXT_STYLE).
  // Kept in sync with the client `FlatField` in
  // src/components/pdf-editor/types.ts.
  style?: TextStyle | null
  // Phase 4a: type-specific config (dropdown choices, radio group/label).
  options?: FieldOptions | null
  // Phase 4a: required flag (ignored by the renderer; used by validation).
  required?: boolean
  // Send-for-signature (Phase 2a) assignment: null/undefined = the sender's
  // own/self-sign field; set = the Recipient.id this field is assigned to.
  // Ignored by the flatten renderer (which only draws geometry + value/style);
  // persisted by saveFields.
  recipientId?: string | null
}

// WinAnsi (Latin-1) coverage that pdf-lib's StandardFonts can encode. pdf-lib
// THROWS on any glyph outside this range, so every text-field value is passed
// through here first: keep the printable ASCII (0x20–0x7E) and the Latin-1
// supplement (0xA0–0xFF); replace everything else (control chars, smart
// quotes, CJK, emoji, …) with '?'. Pragmatic, not a full WinAnsi table — the
// goal is that finalize NEVER crashes on non-Latin input.
function sanitizeWinAnsi(text: string): string {
  let out = ''
  for (const ch of text) {
    const cp = ch.codePointAt(0)
    if (cp === 0x0a || cp === 0x09) {
      out += ch // preserve newline + tab (multi-line text); CR is dropped
    } else if (cp === 0x0d) {
      // drop \r so CRLF collapses to a single \n
    } else if (cp !== undefined && ((cp >= 0x20 && cp <= 0x7e) || (cp >= 0xa0 && cp <= 0xff))) {
      out += ch
    } else {
      out += '?'
    }
  }
  return out
}

// #rrggbb → pdf-lib rgb(); falls back to the default near-black on a bad hex.
function hexToRgb(hex: string) {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex)
  if (!m) return hexToRgb(DEFAULT_TEXT_STYLE.color)
  const n = parseInt(m[1], 16)
  return rgb(((n >> 16) & 0xff) / 255, ((n >> 8) & 0xff) / 255, (n & 0xff) / 255)
}

// Pick the StandardFont enum for a style's family group + bold/italic combo.
function pickStandardFont(style: TextStyle): StandardFonts {
  const group = fontFamilyToStandard(style.fontFamily)
  const b = style.bold
  const i = style.italic
  if (group === 'serif') {
    if (b && i) return StandardFonts.TimesRomanBoldItalic
    if (b) return StandardFonts.TimesRomanBold
    if (i) return StandardFonts.TimesRomanItalic
    return StandardFonts.TimesRoman
  }
  if (group === 'mono') {
    if (b && i) return StandardFonts.CourierBoldOblique
    if (b) return StandardFonts.CourierBold
    if (i) return StandardFonts.CourierOblique
    return StandardFonts.Courier
  }
  // sans (also the fallback for unknown families)
  if (b && i) return StandardFonts.HelveticaBoldOblique
  if (b) return StandardFonts.HelveticaBold
  if (i) return StandardFonts.HelveticaOblique
  return StandardFonts.Helvetica
}

// Merge a stored (possibly null/partial) style with the defaults, clamping the
// size into a sane range so finalize is robust to bad data that slipped past
// saveFields (e.g. legacy rows written before validation existed).
function resolveStyle(style: TextStyle | null | undefined): TextStyle {
  const merged = { ...DEFAULT_TEXT_STYLE, ...(style ?? {}) }
  const size = Number.isFinite(merged.fontSize) ? merged.fontSize : DEFAULT_TEXT_STYLE.fontSize
  merged.fontSize = Math.min(96, Math.max(4, size))
  return merged
}

export async function flattenPdf(pdfBytes: Uint8Array, fields: FlatField[]): Promise<Uint8Array> {
  const doc = await PDFDocument.load(pdfBytes)
  doc.registerFontkit(fontkit)
  // Noto Sans (embedded, subsetted) is used for date fields + the signature
  // text fallback — it covers accented Latin the StandardFonts can't.
  const notoFont = await embedNotoRegular(doc)
  // Per-document cache of embedded StandardFonts, keyed by the enum, so each
  // weight/style is embedded at most once regardless of how many text fields
  // use it.
  const stdFontCache = new Map<StandardFonts, PDFFont>()
  const getStandardFont = async (sf: StandardFonts): Promise<PDFFont> => {
    let f = stdFontCache.get(sf)
    if (!f) {
      f = await doc.embedFont(sf)
      stdFontCache.set(sf, f)
    }
    return f
  }

  const pages = doc.getPages()
  for (const f of fields) {
    const page = pages[f.page - 1]
    if (!page) continue
    const { width, height } = page.getSize()
    const r = normToPdfRect(f, { width, height })

    if ((f.type === 'signature' || f.type === 'initials') && f.value.startsWith('data:image')) {
      // initials share the signature image path (a smaller PNG data URL).
      const b64 = f.value.split(',')[1]
      const bytes = Buffer.from(b64, 'base64')
      const png = await doc.embedPng(bytes)
      page.drawImage(png, { x: r.x, y: r.y, width: r.width, height: r.height })
    } else if (f.type === 'checkbox') {
      // Draw the box outline, plus an X when checked ('true'). An unchecked box
      // ('false') is just the empty outline. A required-but-unset checkbox
      // cannot reach finalize (validation blocks it).
      const inset = Math.min(r.width, r.height) * 0.1
      const side = Math.min(r.width, r.height) - inset * 2
      const bx = r.x + (r.width - side) / 2
      const by = r.y + (r.height - side) / 2
      const dark = rgb(0.1, 0.1, 0.1)
      page.drawRectangle({
        x: bx,
        y: by,
        width: side,
        height: side,
        borderColor: dark,
        borderWidth: Math.max(0.6, side * 0.06),
      })
      if (f.value === 'true') {
        const pad = side * 0.2
        const thickness = Math.max(0.8, side * 0.12)
        page.drawLine({
          start: { x: bx + pad, y: by + pad },
          end: { x: bx + side - pad, y: by + side - pad },
          thickness,
          color: dark,
        })
        page.drawLine({
          start: { x: bx + pad, y: by + side - pad },
          end: { x: bx + side - pad, y: by + pad },
          thickness,
          color: dark,
        })
      }
    } else if (f.type === 'radio') {
      // One option of a group: an outline circle, filled when this option is the
      // group's selection (value === this field's own label).
      const dark = rgb(0.1, 0.1, 0.1)
      const radius = (Math.min(r.width, r.height) / 2) * 0.8
      const cx = r.x + r.width / 2
      const cy = r.y + r.height / 2
      page.drawCircle({
        x: cx,
        y: cy,
        size: radius,
        borderColor: dark,
        borderWidth: Math.max(0.6, radius * 0.12),
      })
      const label = f.options?.label
      if (label != null && f.value === label && f.value !== '') {
        page.drawCircle({ x: cx, y: cy, size: radius * 0.5, color: dark })
      }
    } else if (f.type === 'text') {
      // Styled text: honour font/size/colour/highlight/bold/italic/underline.
      const style = resolveStyle(f.style)
      const font = await getStandardFont(pickStandardFont(style))
      const text = sanitizeWinAnsi(f.value)
      const size = style.fontSize
      const padX = 2
      const lineHeight = size * 1.2
      const textColor = hexToRgb(style.color)

      if (style.highlight) {
        page.drawRectangle({
          x: r.x,
          y: r.y,
          width: r.width,
          height: r.height,
          color: hexToRgb(style.highlight),
        })
      }

      // Multi-line: split on '\n' (Shift+Enter in the editor) and draw each
      // line top-aligned, flowing downward. pdf-lib's y is the baseline in
      // bottom-left coords, so the first line sits near the top of the box.
      const lines = text.split('\n')
      let lineY = r.y + r.height - size
      for (const line of lines) {
        if (line.length > 0) {
          page.drawText(line, { x: r.x + padX, y: lineY, size, font, color: textColor })
          if (style.underline) {
            const lineWidth = font.widthOfTextAtSize(line, size)
            const underlineY = lineY - size * 0.12
            page.drawLine({
              start: { x: r.x + padX, y: underlineY },
              end: { x: r.x + padX + lineWidth, y: underlineY },
              thickness: Math.max(0.5, size * 0.06),
              color: textColor,
            })
          }
        }
        lineY -= lineHeight
      }
    } else {
      // date field, dropdown (the selected option string), or a
      // signature/initials field with a non-image value: draw the value as text
      // via the embedded Noto font (Unicode-safe — covers accented Latin).
      // Date fields render at ~8pt — even the earlier 10pt cap still read as
      // oversized against the small body text on dense declaration/HR forms
      // (users complained), so dates now sit at/below typical body text. With
      // the 8pt floor below this makes the date a fixed ~8pt. Other auto-sized
      // fields (dropdown/signature fallback) keep the taller 18pt cap so short
      // option strings stay legible in larger boxes.
      const sizeCap = f.type === 'date' ? 8 : 18
      const size = Math.max(8, Math.min(r.height * 0.8, sizeCap))
      page.drawText(sanitizeForFont(f.value), {
        x: r.x,
        y: r.y + (r.height - size) / 2,
        size,
        font: notoFont,
        color: rgb(0.1, 0.1, 0.1),
      })
    }
  }
  return doc.save()
}
