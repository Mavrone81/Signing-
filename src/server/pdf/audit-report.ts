import { PDFDocument, rgb, type PDFFont, type PDFPage } from 'pdf-lib'
import fontkit from '@pdf-lib/fontkit'
import { embedNotoFonts, sanitizeForFont } from './font'

// Phase 4c — downloadable audit-trail report. Builds a standalone PDF (NOT
// appended to a document) listing every AuditEvent for a document in
// chronological order. Mirrors the style of certificate.ts (Noto Sans,
// Unicode-safe via sanitizeForFont, A4 with automatic page breaks).

// One resolved audit line. `actorName`/`actorEmail` are pre-resolved by the
// caller: the acting User for user events, or the Recipient (from the event
// detail) for recipient `sign`/`decline` events, or null for system events.
export type AuditReportEvent = {
  action: string
  createdAt: Date
  actorName: string | null
  actorEmail: string | null
  ip: string | null
  userAgent: string | null
}

// PAdES seal metadata for the served signed PDF (only when signing is active +
// the signed blob actually carries a verifiable signature). NEVER carries secret
// key material — only the public signer subject + fingerprint + timestamp.
export type AuditReportSeal = {
  signerSubject: string
  fingerprint: string
  valid: boolean
  signingTime: Date | null
  timestamped: boolean
}

export type AuditReportInfo = {
  documentName: string
  status: string
  originalSha256: string
  signedSha256: string | null
  events: AuditReportEvent[]
  // Optional — present only when the completed PDF is PAdES-sealed.
  seal?: AuditReportSeal | null
}

const TZ_FORMATTER = new Intl.DateTimeFormat('en-SG', {
  timeZone: 'Asia/Singapore',
  dateStyle: 'medium',
  timeStyle: 'medium',
})

// Human-readable label per AuditAction.
const ACTION_LABEL: Record<string, string> = {
  upload: 'Document uploaded',
  send: 'Sent for signature',
  viewed: 'Viewed by recipient',
  sign: 'Signed by recipient',
  decline: 'Declined by recipient',
  finalize: 'Document finalized',
  download: 'Signed document downloaded',
  reset: 'Reset to draft',
  notify: 'Notification email',
}

const PAGE_W = 595
const PAGE_H = 842 // A4
const MARGIN = 50
const LABEL_SIZE = 11
const VALUE_SIZE = 11
const LINE_GAP = 20

type Cursor = { page: PDFPage; y: number }

function ensureSpace(doc: PDFDocument, c: Cursor, needed: number): void {
  if (c.y - needed < MARGIN) {
    c.page = doc.addPage([PAGE_W, PAGE_H])
    c.y = PAGE_H - MARGIN
  }
}

// A bold label followed by its value on the next line (same shape as the
// certificate's writer).
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

// A single indented value line (no label) — used for the per-event sub-fields.
function drawLine(
  doc: PDFDocument,
  c: Cursor,
  text: string,
  font: PDFFont,
  size = 10,
): void {
  ensureSpace(doc, c, 14)
  c.page.drawText(sanitizeForFont(text), {
    x: MARGIN + 14,
    y: c.y,
    size,
    font,
    color: rgb(0.25, 0.25, 0.25),
  })
  c.y -= 15
}

export async function buildAuditReport(info: AuditReportInfo): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  doc.registerFontkit(fontkit)
  const { regular: font, bold: boldFont } = await embedNotoFonts(doc)

  const c: Cursor = { page: doc.addPage([PAGE_W, PAGE_H]), y: PAGE_H - MARGIN }

  c.page.drawText(sanitizeForFont('Audit Trail'), {
    x: MARGIN,
    y: c.y,
    size: 20,
    font: boldFont,
    color: rgb(0, 0, 0),
  })
  c.y -= 34

  // Header: document identity + integrity hashes.
  drawLabelledValue(doc, c, 'Document', info.documentName, font, boldFont)
  drawLabelledValue(doc, c, 'Status', info.status, font, boldFont)
  drawLabelledValue(doc, c, 'Original Document SHA-256', info.originalSha256, font, boldFont)
  drawLabelledValue(doc, c, 'Signed Document SHA-256', info.signedSha256 ?? 'N/A', font, boldFont)
  if (info.seal) {
    const when = info.seal.signingTime ? TZ_FORMATTER.format(info.seal.signingTime) : 'n/a'
    drawLabelledValue(
      doc,
      c,
      'Digital Seal (PAdES)',
      `Digitally sealed by ${info.seal.signerSubject} · SHA-256 ${info.seal.fingerprint} · ` +
        `signed ${when}${info.seal.timestamped ? ' · RFC-3161 timestamp embedded' : ''} · ` +
        `integrity ${info.seal.valid ? 'VERIFIED' : 'FAILED'}`,
      font,
      boldFont,
    )
  }
  drawLabelledValue(
    doc,
    c,
    'Report Generated (Asia/Singapore)',
    TZ_FORMATTER.format(new Date()),
    font,
    boldFont,
  )

  c.y -= 6
  ensureSpace(doc, c, 24)
  c.page.drawText(sanitizeForFont(`Events (${info.events.length})`), {
    x: MARGIN,
    y: c.y,
    size: 14,
    font: boldFont,
    color: rgb(0, 0, 0),
  })
  c.y -= 24

  if (info.events.length === 0) {
    drawLine(doc, c, 'No audit events recorded for this document.', font)
  }

  info.events.forEach((e, i) => {
    ensureSpace(doc, c, 60)
    const label = ACTION_LABEL[e.action] ?? e.action
    c.page.drawText(sanitizeForFont(`${i + 1}. ${label}`), {
      x: MARGIN,
      y: c.y,
      size: 12,
      font: boldFont,
      color: rgb(0.05, 0.05, 0.05),
    })
    c.y -= 16

    drawLine(doc, c, `When: ${TZ_FORMATTER.format(e.createdAt)}`, font)

    const actor =
      e.actorName && e.actorEmail
        ? `${e.actorName} <${e.actorEmail}>`
        : e.actorName || e.actorEmail || 'System'
    drawLine(doc, c, `Actor: ${actor}`, font)

    if (e.ip) drawLine(doc, c, `IP: ${e.ip}`, font)
    if (e.userAgent) drawLine(doc, c, `User agent: ${e.userAgent}`, font)
    c.y -= 6
  })

  return doc.save()
}
