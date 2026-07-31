// @vitest-environment node
//
// Server-only pdf-lib/fontkit code; see flatten.test.ts for why this must
// run under the plain `node` environment rather than the project's jsdom
// default.
import { describe, it, expect } from 'vitest'
import { PDFDocument } from 'pdf-lib'
import fontkit from '@pdf-lib/fontkit'
import { embedNotoFonts, sanitizeForFont } from '../../src/server/pdf/font'

describe('sanitizeForFont', () => {
  it('leaves accented Latin text unchanged (covered by Noto Sans Regular)', () => {
    expect(sanitizeForFont('José')).toBe('José')
    expect(sanitizeForFont('Müller')).toBe('Müller')
  })

  it('replaces characters not covered by Noto Sans Regular with "?"', () => {
    expect(sanitizeForFont('签名')).toBe('??')
  })

  it('replaces only the uncovered characters in a mixed string', () => {
    expect(sanitizeForFont('签名 José')).toBe('?? José')
  })

  it('iterates by code point, not UTF-16 code unit, so it does not split astral characters', () => {
    // U+1F600 GRINNING FACE is a surrogate pair in UTF-16 and not covered by
    // Noto Sans Regular. A code-unit-based (rather than code-point-based)
    // implementation would emit two '?' — one per surrogate half — instead
    // of one.
    const astral = '\u{1F600}'
    expect([...astral].length).toBe(1) // sanity: one code point
    expect(sanitizeForFont(astral)).toBe('?')
  })

  it('passes tab and newline through unchanged (pdf-lib parses these out before font encoding), while still replacing a genuinely-uncovered character', () => {
    expect(sanitizeForFont('line1\nline2\tcol')).toBe('line1\nline2\tcol')
    expect(sanitizeForFont('line1\nline2\tcol签')).toBe('line1\nline2\tcol?')
  })
})

describe('embedNotoFonts', () => {
  it('embeds both weights into a PDFDocument and draws non-Latin + accented-Latin text without throwing', async () => {
    const doc = await PDFDocument.create()
    doc.registerFontkit(fontkit)
    const { regular, bold } = await embedNotoFonts(doc)
    const page = doc.addPage([400, 200])

    expect(() => {
      page.drawText(sanitizeForFont('José Müller'), { x: 10, y: 150, size: 14, font: regular })
      page.drawText(sanitizeForFont('José Müller'), { x: 10, y: 100, size: 14, font: bold })
      page.drawText(sanitizeForFont('签名 José'), { x: 10, y: 50, size: 14, font: regular })
    }).not.toThrow()

    const bytes = await doc.save()
    const reloaded = await PDFDocument.load(bytes)
    expect(reloaded.getPageCount()).toBe(1)
  })
})
