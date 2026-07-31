import fs from 'node:fs'
import path from 'node:path'
import fontkit from '@pdf-lib/fontkit'
import type { PDFDocument, PDFFont } from 'pdf-lib'

// Noto Sans (SIL OFL 1.1) — Latin, incl. Latin Extended for accented
// European names. Full CJK/Tamil coverage is an explicit future follow-up
// (would need the much larger Noto CJK/Tamil font families); anything those
// glyphs are missing gets sanitized to '?' below rather than crashing
// pdf-lib's drawText.
//
// Read via `process.cwd()` rather than `__dirname`/import.meta.url: in the
// Next.js standalone runner, cwd is `/app` and the Dockerfile copies
// `public/` there (`COPY --from=builder /app/public ./public`), so
// `public/fonts/*.ttf` resolves at runtime. In dev and tests, cwd is the
// repo root, where `public/` also lives. This matches the existing
// public/pdf.worker.min.mjs bundling pattern used elsewhere in this repo.
const REGULAR_PATH = path.join(process.cwd(), 'public/fonts/NotoSans-Regular.ttf')
const BOLD_PATH = path.join(process.cwd(), 'public/fonts/NotoSans-Bold.ttf')

let regularBytesCache: Buffer | null = null
let boldBytesCache: Buffer | null = null

function getRegularBytes(): Buffer {
  if (!regularBytesCache) regularBytesCache = fs.readFileSync(REGULAR_PATH)
  return regularBytesCache
}

function getBoldBytes(): Buffer {
  if (!boldBytesCache) boldBytesCache = fs.readFileSync(BOLD_PATH)
  return boldBytesCache
}

/**
 * Embed Noto Sans Regular only, into the given PDFDocument, subsetted to the
 * glyphs actually used. Caller must have already called
 * `doc.registerFontkit(fontkit)` — embedding is per-PDFDocument, unlike the
 * byte-loading above which is cached module-wide.
 *
 * Use this instead of `embedNotoFonts` wherever bold isn't drawn (e.g.
 * flatten.ts) — embedding an unused weight still costs the full font unless
 * it's never embedded at all.
 */
export async function embedNotoRegular(doc: PDFDocument): Promise<PDFFont> {
  return doc.embedFont(getRegularBytes(), { subset: true })
}

/**
 * Embed Noto Sans (regular + bold) into the given PDFDocument, each
 * subsetted to only the glyphs actually drawn. Caller must have already
 * called `doc.registerFontkit(fontkit)` — embedding is per-PDFDocument,
 * unlike the byte-loading above which is cached module-wide.
 */
export async function embedNotoFonts(doc: PDFDocument): Promise<{ regular: PDFFont; bold: PDFFont }> {
  const regular = await embedNotoRegular(doc)
  const bold = await doc.embedFont(getBoldBytes(), { subset: true })
  return { regular, bold }
}

// Parsed once (not per-call) and reused for glyph-coverage checks.
let parsedFontCache: ReturnType<typeof fontkit.create> | null = null

function getParsedFont() {
  if (!parsedFontCache) parsedFontCache = fontkit.create(getRegularBytes())
  return parsedFontCache
}

const FALLBACK_CHAR = '?'

// Whitespace/control code points that pdf-lib's own `cleanText`/`lineSplit`
// consume BEFORE font encoding (\t, \n, \v, \f, \r) — these must reach
// drawText unchanged, since fonts never have glyphs for them and glyph-
// checking would otherwise replace them with '?', destroying line breaks and
// tabs. Deliberately narrow: other control chars (e.g. \b) are NOT in this
// set and continue to be sanitized below, since they have no pdf-lib
// handling and would otherwise reach font encoding as-is.
const PDF_LIB_WHITESPACE_CODEPOINTS = new Set([0x09, 0x0a, 0x0b, 0x0c, 0x0d])

/**
 * Replace every character the embedded Noto Sans Regular font cannot render
 * with a safe fallback ('?'), so `page.drawText` never throws on
 * non-Latin-1 input (Chinese, Tamil, etc. — full coverage of those is a
 * future follow-up, not this fix). Regular and Bold Noto Sans share the same
 * glyph coverage for our purposes, so checking against Regular is
 * sufficient for text drawn in either weight.
 *
 * The whitespace/control characters that pdf-lib's `drawText` itself parses
 * out before font encoding (tab, newline, vertical tab, form feed, carriage
 * return) are passed through unchanged rather than glyph-checked — fonts
 * have no glyphs for them, so glyph-checking would always replace them with
 * '?', silently destroying line breaks and tabs.
 *
 * Iterates by Unicode code point (not UTF-16 code unit) via `for...of` so
 * astral characters (surrogate pairs) are treated as one unit rather than
 * being split into two lone surrogates.
 */
export function sanitizeForFont(text: string): string {
  const font = getParsedFont()
  let out = ''
  for (const char of text) {
    const codePoint = char.codePointAt(0)
    if (codePoint !== undefined && PDF_LIB_WHITESPACE_CODEPOINTS.has(codePoint)) {
      out += char
    } else if (codePoint !== undefined && font.hasGlyphForCodePoint(codePoint)) {
      out += char
    } else {
      out += FALLBACK_CHAR
    }
  }
  return out
}
