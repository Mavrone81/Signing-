import { PDFDocument, rgb, type PDFFont, type PDFPage } from 'pdf-lib'
import fontkit from '@pdf-lib/fontkit'
import { embedNotoFonts, sanitizeForFont } from './font'

export type CertInfo = {
  signerName: string
  signerEmail: string
  signedAt: Date
  ip: string | null
  originalSha256: string
  signedSha256: string
}

// A single signer on a multi-recipient document (Phase 2b). One block is
// rendered per signer on the certificate page.
export type CertSigner = {
  name: string
  email: string
  signedAt: Date
  ip: string | null
}

export type MultiCertInfo = {
  signers: CertSigner[]
  originalSha256: string
  signedSha256: string
}

const TZ_FORMATTER = new Intl.DateTimeFormat('en-SG', {
  timeZone: 'Asia/Singapore',
  dateStyle: 'medium',
  timeStyle: 'medium',
})

const PAGE_W = 595
const PAGE_H = 842 // A4
const MARGIN = 50
const LABEL_SIZE = 11
const VALUE_SIZE = 11
const LINE_GAP = 26

// Shared low-level writer: a bold label line followed by its value line,
// starting at `y`, returning the new `y`. Adds a fresh page and resets `y`
// when the current one is nearly full (keeps many-signer certificates from
// running off the bottom of the page).
type Cursor = { page: PDFPage; y: number }

function ensureSpace(doc: PDFDocument, c: Cursor, needed: number): void {
  if (c.y - needed < MARGIN) {
    c.page = doc.addPage([PAGE_W, PAGE_H])
    c.y = PAGE_H - MARGIN
  }
}

function drawLabelledValue(
  doc: PDFDocument,
  c: Cursor,
  label: string,
  value: string,
  font: PDFFont,
  boldFont: PDFFont,
): void {
  ensureSpace(doc, c, 14 + LINE_GAP)
  c.page.drawText(sanitizeForFont(`${label}:`), {
    x: MARGIN,
    y: c.y,
    size: LABEL_SIZE,
    font: boldFont,
    color: rgb(0.1, 0.1, 0.1),
  })
  c.y -= 14
  c.page.drawText(sanitizeForFont(value), {
    x: MARGIN,
    y: c.y,
    size: VALUE_SIZE,
    font,
    color: rgb(0.1, 0.1, 0.1),
  })
  c.y -= LINE_GAP
}

// Single-signer certificate (self-sign path). UNCHANGED public shape: the
// self-sign finalize in actions.ts still calls this with one signer's details.
export async function appendCertificate(signedBytes: Uint8Array, info: CertInfo): Promise<Uint8Array> {
  return appendMultiSignerCertificate(signedBytes, {
    signers: [
      { name: info.signerName, email: info.signerEmail, signedAt: info.signedAt, ip: info.ip },
    ],
    originalSha256: info.originalSha256,
    signedSha256: info.signedSha256,
  })
}

// Multi-signer certificate (Phase 2b): one block per signer (name, email,
// signed-at in Asia/Singapore, IP) followed by the original + signed SHA-256.
// A one-element `signers` list reproduces the original single-signer layout.
export async function appendMultiSignerCertificate(
  signedBytes: Uint8Array,
  info: MultiCertInfo,
): Promise<Uint8Array> {
  const doc = await PDFDocument.load(signedBytes)
  doc.registerFontkit(fontkit)
  const { regular: font, bold: boldFont } = await embedNotoFonts(doc)

  const c: Cursor = { page: doc.addPage([PAGE_W, PAGE_H]), y: PAGE_H - MARGIN }

  c.page.drawText(sanitizeForFont('Signature Certificate'), {
    x: MARGIN,
    y: c.y,
    size: 20,
    font: boldFont,
    color: rgb(0, 0, 0),
  })
  c.y -= 40

  const multi = info.signers.length > 1
  info.signers.forEach((s, i) => {
    if (multi) {
      ensureSpace(doc, c, 14 + LINE_GAP)
      c.page.drawText(sanitizeForFont(`Signer ${i + 1}`), {
        x: MARGIN,
        y: c.y,
        size: 13,
        font: boldFont,
        color: rgb(0, 0, 0),
      })
      c.y -= 22
    }
    drawLabelledValue(doc, c, 'Signer Name', s.name, font, boldFont)
    drawLabelledValue(doc, c, 'Signer Email', s.email, font, boldFont)
    drawLabelledValue(doc, c, 'Signed At (Asia/Singapore)', TZ_FORMATTER.format(s.signedAt), font, boldFont)
    drawLabelledValue(doc, c, 'IP Address', s.ip ?? 'N/A', font, boldFont)
    if (multi) c.y -= 8
  })

  drawLabelledValue(doc, c, 'Original Document SHA-256', info.originalSha256, font, boldFont)
  drawLabelledValue(doc, c, 'Signed Document SHA-256', info.signedSha256, font, boldFont)

  return doc.save()
}
