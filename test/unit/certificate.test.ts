// @vitest-environment node
//
// Server-only pdf-lib code; see flatten.test.ts for why this must run under
// the plain `node` environment rather than the project's jsdom default.
import { describe, it, expect } from 'vitest'
import { PDFDocument } from 'pdf-lib'
import { appendCertificate, appendMultiSignerCertificate } from '../../src/server/pdf/certificate'

// Prior to the Noto Sans font fix, certificate.ts drew text with pdf-lib's
// StandardFonts, which use single-byte WinAnsi character codes — so a
// naive "inflate the content stream, hex-decode the Tj strings as latin1"
// trick happened to reconstruct readable ASCII. Embedding a custom TTF via
// fontkit instead produces a CIDFontType2/Identity-H font: the hex strings
// in the content stream are 2-byte *glyph IDs* assigned in embedding order,
// not character codes, so that trick no longer decodes to anything
// meaningful. pdf-lib does still write a ToUnicode CMap for custom-embedded
// fonts (for copy-paste/search/accessibility), so a real PDF text-extraction
// pass — via pdfjs-dist, already a project dependency for the PDF viewer —
// correctly recovers the rendered text regardless of encoding.
async function extractPageText(bytes: Uint8Array, pageNumber: number): Promise<string> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const doc = await pdfjs.getDocument({ data: bytes }).promise
  const page = await doc.getPage(pageNumber)
  const content = await page.getTextContent()
  return content.items.map((item) => ('str' in item ? item.str : '')).join('')
}

describe('appendCertificate', () => {
  it('adds exactly one page with signer info', async () => {
    const d = await PDFDocument.create()
    d.addPage([600, 800])
    const src = await d.save()
    const out = await appendCertificate(src, {
      signerName: 'Sam',
      signerEmail: 's@x.com',
      signedAt: new Date('2026-07-14T02:00:00Z'),
      ip: '1.2.3.4',
      originalSha256: 'a'.repeat(64),
      signedSha256: 'b'.repeat(64),
    })
    expect((await PDFDocument.load(out)).getPageCount()).toBe(2)
  })

  it('renders signer name, email, ip, and both hashes as text on the certificate page', async () => {
    const d = await PDFDocument.create()
    d.addPage([600, 800])
    const src = await d.save()
    const out = await appendCertificate(src, {
      signerName: 'Sam',
      signerEmail: 's@x.com',
      signedAt: new Date('2026-07-14T02:00:00Z'),
      ip: '1.2.3.4',
      originalSha256: 'a'.repeat(64),
      signedSha256: 'b'.repeat(64),
    })

    const text = await extractPageText(out, 2)
    expect(text).toContain('Sam')
    expect(text).toContain('s@x.com')
    expect(text).toContain('1.2.3.4')
    expect(text).toContain('a'.repeat(64))
    expect(text).toContain('b'.repeat(64))
  })

  it('formats signedAt in Asia/Singapore time', async () => {
    const d = await PDFDocument.create()
    d.addPage([600, 800])
    const src = await d.save()
    const signedAt = new Date('2026-07-14T02:00:00Z') // 10:00 SGT
    const out = await appendCertificate(src, {
      signerName: 'Sam',
      signerEmail: 's@x.com',
      signedAt,
      ip: '1.2.3.4',
      originalSha256: 'a'.repeat(64),
      signedSha256: 'b'.repeat(64),
    })
    const expected = new Intl.DateTimeFormat('en-SG', {
      timeZone: 'Asia/Singapore',
      dateStyle: 'medium',
      timeStyle: 'medium',
    }).format(signedAt)
    const text = await extractPageText(out, 2)
    expect(text).toContain(expected)
  })

  it('does not throw on a signer name with non-Latin and accented-Latin characters, and appends exactly one page', async () => {
    const d = await PDFDocument.create()
    d.addPage([600, 800])
    const src = await d.save()
    const out = await appendCertificate(src, {
      signerName: '李明 José Müller',
      signerEmail: 's@x.com',
      signedAt: new Date('2026-07-14T02:00:00Z'),
      ip: '1.2.3.4',
      originalSha256: 'a'.repeat(64),
      signedSha256: 'b'.repeat(64),
    })
    const re = await PDFDocument.load(out)
    expect(re.getPageCount()).toBe(2)

    // The accented-Latin portion is covered by Noto Sans and should survive
    // sanitization unchanged; the CJK portion is expected to be replaced.
    const text = await extractPageText(out, 2)
    expect(text).toContain('José Müller')
  })

  it('multi-signer: lists every signer (name, email, ip) plus both hashes', async () => {
    const d = await PDFDocument.create()
    d.addPage([600, 800])
    const src = await d.save()
    const out = await appendMultiSignerCertificate(src, {
      signers: [
        { name: 'Alice A', email: 'alice@x.com', signedAt: new Date('2026-07-14T02:00:00Z'), ip: '1.1.1.1' },
        { name: 'Bob B', email: 'bob@x.com', signedAt: new Date('2026-07-14T03:00:00Z'), ip: '2.2.2.2' },
      ],
      originalSha256: 'a'.repeat(64),
      signedSha256: 'b'.repeat(64),
    })
    const text = await extractPageText(out, 2)
    expect(text).toContain('Alice A')
    expect(text).toContain('alice@x.com')
    expect(text).toContain('1.1.1.1')
    expect(text).toContain('Bob B')
    expect(text).toContain('bob@x.com')
    expect(text).toContain('2.2.2.2')
    expect(text).toContain('a'.repeat(64))
    expect(text).toContain('b'.repeat(64))
  })

  it('multi-signer: paginates when there are many signers (no overflow crash)', async () => {
    const d = await PDFDocument.create()
    d.addPage([600, 800])
    const src = await d.save()
    const signers = Array.from({ length: 12 }, (_, i) => ({
      name: `Signer ${i}`,
      email: `s${i}@x.com`,
      signedAt: new Date('2026-07-14T02:00:00Z'),
      ip: `10.0.0.${i}`,
    }))
    const out = await appendMultiSignerCertificate(src, {
      signers,
      originalSha256: 'a'.repeat(64),
      signedSha256: 'b'.repeat(64),
    })
    const loaded = await PDFDocument.load(out)
    // original page + at least one certificate page (more when signers overflow)
    expect(loaded.getPageCount()).toBeGreaterThanOrEqual(2)
  })

  it('renders "N/A" (or similar) when ip is null, without throwing', async () => {
    const d = await PDFDocument.create()
    d.addPage([600, 800])
    const src = await d.save()
    const out = await appendCertificate(src, {
      signerName: 'Sam',
      signerEmail: 's@x.com',
      signedAt: new Date('2026-07-14T02:00:00Z'),
      ip: null,
      originalSha256: 'a'.repeat(64),
      signedSha256: 'b'.repeat(64),
    })
    expect((await PDFDocument.load(out)).getPageCount()).toBe(2)
  })
})
