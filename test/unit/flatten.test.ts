// @vitest-environment node
//
// This file must run in the plain Node environment, not jsdom (the project
// default). jsdom's vm-sandboxed realm gives `Buffer` instances that fail
// `instanceof Uint8Array` checks against jsdom's own TypedArray globals,
// which breaks pdf-lib's `embedPng` type validation (a cross-realm quirk of
// jsdom/vitest, unrelated to flatten.ts's own logic). flatten.ts is
// server-only code with no DOM dependency, so running it under `node` here
// is also more representative of its real runtime.
import { describe, it, expect } from 'vitest'
import { PDFDocument, PDFDict, PDFName, PDFStream } from 'pdf-lib'
import { flattenPdf } from '../../src/server/pdf/flatten'

async function blankPdf() {
  const d = await PDFDocument.create()
  d.addPage([600, 800])
  return d.save()
}

async function multiPagePdf(count: number) {
  const d = await PDFDocument.create()
  for (let i = 0; i < count; i++) d.addPage([600, 800])
  return d.save()
}

// A minimal, valid 1x1 transparent PNG, base64-encoded.
const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='

function pageHasEmbeddedImage(page: ReturnType<PDFDocument['getPage']>): boolean {
  const resources = page.node.Resources()
  if (!resources || !(resources instanceof PDFDict)) return false
  const xObjects = resources.lookupMaybe(PDFName.of('XObject'), PDFDict)
  if (!xObjects) return false
  for (const key of xObjects.keys()) {
    const value = xObjects.lookupMaybe(key, PDFStream)
    if (value) {
      const subtype = value.dict.lookupMaybe(PDFName.of('Subtype'), PDFName)
      if (subtype && subtype.asString() === '/Image') return true
    }
  }
  return false
}

describe('flattenPdf', () => {
  it('keeps page count and returns valid pdf with a text field drawn', async () => {
    const src = await blankPdf()
    const out = await flattenPdf(src, [{ page: 1, type: 'text', x: 0.1, y: 0.1, w: 0.3, h: 0.05, value: 'Hello' }])
    const re = await PDFDocument.load(out)
    expect(re.getPageCount()).toBe(1)
    expect(out.length).toBeGreaterThan(src.length - 50) // content added
  })

  it('skips out-of-range page without throwing', async () => {
    const src = await blankPdf()
    const out = await flattenPdf(src, [{ page: 5, type: 'text', x: 0, y: 0, w: 0.1, h: 0.1, value: 'x' }])
    expect((await PDFDocument.load(out)).getPageCount()).toBe(1)
  })

  it('embeds a signature PNG and draws it as an image XObject on the page', async () => {
    const src = await blankPdf()
    const textOnly = await flattenPdf(src, [
      { page: 1, type: 'text', x: 0.1, y: 0.1, w: 0.3, h: 0.05, value: 'Hello' },
    ])
    const withSignature = await flattenPdf(src, [
      {
        page: 1,
        type: 'signature',
        x: 0.1,
        y: 0.1,
        w: 0.3,
        h: 0.1,
        value: `data:image/png;base64,${TINY_PNG_BASE64}`,
      },
    ])

    // Should not throw, and should produce a differently-sized document than
    // a text-only flatten (proves the embedPng/drawImage branch actually ran).
    expect(withSignature.length).not.toBe(textOnly.length)

    const re = await PDFDocument.load(withSignature)
    expect(re.getPageCount()).toBe(1)
    expect(pageHasEmbeddedImage(re.getPage(0))).toBe(true)

    // Sanity check: the text-only sibling has no embedded image XObject.
    const reTextOnly = await PDFDocument.load(textOnly)
    expect(pageHasEmbeddedImage(reTextOnly.getPage(0))).toBe(false)
  })

  it('does not throw on a non-Latin text value and returns a valid, larger pdf', async () => {
    const src = await blankPdf()
    const out = await flattenPdf(src, [
      { page: 1, type: 'text', x: 0.1, y: 0.1, w: 0.3, h: 0.05, value: '签名 José' },
    ])
    const re = await PDFDocument.load(out)
    expect(re.getPageCount()).toBe(1)
    expect(out.length).toBeGreaterThan(src.length)
  })

  it('renders a fully-styled text field (sans bold underline + highlight) without throwing', async () => {
    const src = await blankPdf()
    const out = await flattenPdf(src, [
      {
        page: 1,
        type: 'text',
        x: 0.1,
        y: 0.1,
        w: 0.4,
        h: 0.06,
        value: 'Styled text',
        style: {
          fontFamily: 'Arial',
          fontSize: 14,
          color: '#0055aa',
          highlight: '#ffee00',
          bold: true,
          italic: false,
          underline: true,
        },
      },
    ])
    const re = await PDFDocument.load(out)
    expect(re.getPageCount()).toBe(1)
    expect(out.length).toBeGreaterThan(src.length) // content added
  })

  it('sanitizes a non-Latin styled text value to WinAnsi rather than throwing', async () => {
    const src = await blankPdf()
    // '签名' is CJK (outside WinAnsi) → must be replaced with '?' by
    // sanitizeWinAnsi so pdf-lib's StandardFont drawText never throws.
    const out = await flattenPdf(src, [
      {
        page: 1,
        type: 'text',
        x: 0.1,
        y: 0.1,
        w: 0.4,
        h: 0.06,
        value: '签名 A',
        style: {
          fontFamily: 'Times New Roman',
          fontSize: 12,
          color: '#111827',
          highlight: null,
          bold: false,
          italic: true,
          underline: false,
        },
      },
    ])
    const re = await PDFDocument.load(out)
    expect(re.getPageCount()).toBe(1)
    expect(out.length).toBeGreaterThan(src.length)
  })

  // ---- Phase 4a: new field types ----

  it('draws a checked checkbox (true) and an empty checkbox (false) without throwing, page count preserved', async () => {
    const src = await blankPdf()
    const checked = await flattenPdf(src, [
      { page: 1, type: 'checkbox', x: 0.1, y: 0.1, w: 0.04, h: 0.03, value: 'true' },
    ])
    const unchecked = await flattenPdf(src, [
      { page: 1, type: 'checkbox', x: 0.1, y: 0.1, w: 0.04, h: 0.03, value: 'false' },
    ])
    expect((await PDFDocument.load(checked)).getPageCount()).toBe(1)
    expect((await PDFDocument.load(unchecked)).getPageCount()).toBe(1)
    // A checked box draws extra strokes (the X), so its content differs.
    expect(checked.length).not.toBe(unchecked.length)
  })

  it('embeds an initials PNG as an image XObject (same path as signature)', async () => {
    const src = await blankPdf()
    const out = await flattenPdf(src, [
      { page: 1, type: 'initials', x: 0.1, y: 0.1, w: 0.12, h: 0.06, value: `data:image/png;base64,${TINY_PNG_BASE64}` },
    ])
    const re = await PDFDocument.load(out)
    expect(re.getPageCount()).toBe(1)
    expect(pageHasEmbeddedImage(re.getPage(0))).toBe(true)
  })

  it('draws a selected radio (value === label) and an unselected one without throwing', async () => {
    const src = await blankPdf()
    const selected = await flattenPdf(src, [
      { page: 1, type: 'radio', x: 0.1, y: 0.1, w: 0.04, h: 0.03, value: 'Yes', options: { group: 'g', label: 'Yes' } },
    ])
    const unselected = await flattenPdf(src, [
      { page: 1, type: 'radio', x: 0.1, y: 0.1, w: 0.04, h: 0.03, value: 'No', options: { group: 'g', label: 'Yes' } },
    ])
    expect((await PDFDocument.load(selected)).getPageCount()).toBe(1)
    expect((await PDFDocument.load(unselected)).getPageCount()).toBe(1)
    // The selected option draws the inner dot too → different content length.
    expect(selected.length).not.toBe(unselected.length)
  })

  it('draws a dropdown value as text without throwing', async () => {
    const src = await blankPdf()
    const out = await flattenPdf(src, [
      { page: 1, type: 'dropdown', x: 0.1, y: 0.1, w: 0.2, h: 0.05, value: 'Choice B', options: { choices: ['Choice A', 'Choice B'] } },
    ])
    const re = await PDFDocument.load(out)
    expect(re.getPageCount()).toBe(1)
    expect(out.length).toBeGreaterThan(src.length)
  })

  it('places a field on the correct page in a multi-page document', async () => {
    const src = await multiPagePdf(3)
    const out = await flattenPdf(src, [
      { page: 2, type: 'text', x: 0.1, y: 0.1, w: 0.3, h: 0.05, value: 'Page2Field' },
    ])
    const re = await PDFDocument.load(out)
    expect(re.getPageCount()).toBe(3)

    // A freshly-created blank page has no content stream at all, so
    // Contents() being defined proves drawText actually ran on that page.
    // Page 2 (index 1) should have gained a content stream; pages 1 and 3
    // (indices 0 and 2) must remain untouched, proving pages[f.page - 1]
    // selected the correct page rather than always page 1.
    expect(re.getPage(0).node.Contents()).toBeUndefined()
    expect(re.getPage(1).node.Contents()).toBeDefined()
    expect(re.getPage(2).node.Contents()).toBeUndefined()
  })
})
