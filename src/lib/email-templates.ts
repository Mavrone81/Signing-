// Pure, dependency-free email renderers (no DB, no I/O) — unit-tested. Each
// returns { subject, html, text }: a branded, inline-styled (email clients
// ignore <style>/external CSS) responsive HTML body plus a plain-text fallback.
// The "Bevora Sign" wordmark is text-only — email clients block remote images.

// Bevora design-system colours, inlined as literals because email clients
// strip CSS custom properties — these must stay in step with
// src/app/globals.css by hand.
const BRAND = '#b8860b' // core brand gold — wordmark accent (large text only)
// A deeper step of the same gold. Used wherever white text sits ON the colour,
// or the colour is small text on white: white on #b8860b is only ~3.4:1, which
// fails WCAG AA for body-size text, while #976c0c clears 4.5:1 both ways.
const BRAND_DARK = '#976c0c'
const INK = '#1a1917'
const MUTED = '#54514a'
const EDGE = '#e9e7e3'
const SHELL = '#faf9f7'

export type RenderedEmail = { subject: string; html: string; text: string }

// White-label branding for an org (Phase 5). When present, the org's name +
// colour replace the generic "Bevora Sign" wordmark + green in the shell. Absent =
// generic Bevora Sign identity (existing behaviour). Kept intentionally tiny —
// logos in email are unreliable, so name + colour is enough.
export type EmailBrand = { name: string; color: string }

// Basic HTML-escape for any user-supplied string interpolated into the markup.
function esc(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

// A safe `#rrggbb`/`#rgb` colour for inline CSS — never let a stored brand
// colour inject arbitrary style. `fallback` lets the caller pick the right
// default for the contrast context: BRAND reads as the brand accent on white,
// BRAND_DARK is the one safe to put white text on.
function safeColor(c: string | undefined, fallback: string = BRAND): string {
  return c && /^#[0-9a-fA-F]{3,8}$/.test(c) ? c : fallback
}

// The header wordmark: the org's (escaped) brand name when branded, else the
// styled Bevora/Sign wordmark.
function headerMark(brand?: EmailBrand): string {
  if (brand) {
    return `<span style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:20px;font-weight:700;color:${safeColor(brand.color)};">${esc(brand.name)}</span>`
  }
  return `<span style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:20px;font-weight:700;color:${INK};">Bevora<span style="color:${BRAND};"> Sign</span></span>`
}

// Shared shell: header wordmark, a white card with `bodyHtml`, and a footer.
function layout(bodyHtml: string, brand?: EmailBrand): string {
  const senderName = brand ? esc(brand.name) : 'Bevora Sign'
  return `<!-- Bevora Sign -->
<div style="margin:0;padding:0;background-color:${SHELL};">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:${SHELL};padding:24px 0;">
    <tr>
      <td align="center">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;">
          <tr>
            <td style="padding:8px 24px 16px;">
              ${headerMark(brand)}
            </td>
          </tr>
          <tr>
            <td style="background-color:#ffffff;border:1px solid ${EDGE};border-radius:14px;padding:32px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
              ${bodyHtml}
            </td>
          </tr>
          <tr>
            <td style="padding:16px 24px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:12px;color:${MUTED};">
              Sent by ${senderName}. If you weren't expecting this, you can safely ignore this email.
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</div>`
}

function button(href: string, label: string, brand?: EmailBrand): string {
  // White label text sits on this fill, so the unbranded default is the deeper
  // gold rather than BRAND (see the BRAND_DARK note above).
  const bg = safeColor(brand?.color, BRAND_DARK)
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:24px 0;"><tr>
    <td style="border-radius:10px;background-color:${bg};">
      <a href="${esc(href)}" style="display:inline-block;padding:13px 28px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:10px;">${esc(label)}</a>
    </td>
  </tr></table>`
}

const h = (t: string) =>
  `<h1 style="margin:0 0 12px;font-size:20px;font-weight:600;color:${INK};">${t}</h1>`
const p = (t: string) =>
  `<p style="margin:0 0 14px;font-size:15px;line-height:1.55;color:${INK};">${t}</p>`
const small = (t: string) =>
  `<p style="margin:14px 0 0;font-size:13px;line-height:1.5;color:${MUTED};">${t}</p>`

// --- Request to sign (also used for reminders via `reminder: true`) ----------

// The sender's personal note, set apart from our own wording so the recipient
// can tell who wrote what. Escaped; line breaks kept.
function senderNote(message: string, senderName: string): string {
  const body = esc(message).replace(/\n/g, '<br>')
  return (
    `<div style="margin:0 0 16px;padding:12px 14px;border-left:3px solid ${EDGE};background:${SHELL};">` +
    `<p style="margin:0 0 6px;font-size:12px;color:${MUTED};">Message from ${esc(senderName)}</p>` +
    `<p style="margin:0;font-size:14px;line-height:1.55;color:${INK};">${body}</p>` +
    `</div>`
  )
}

export function renderRequestEmail(opts: {
  recipientName: string
  senderName: string
  docName: string
  signUrl: string
  reminder?: boolean
  // The sender's note (Document.inviteMessage); null/omitted = none.
  message?: string | null
  brand?: EmailBrand
}): RenderedEmail {
  const { recipientName, senderName, docName, signUrl, reminder, message, brand } = opts
  const subject = reminder
    ? `Reminder: ${senderName} has requested your signature on ${docName}`
    : `${senderName} has requested your signature on ${docName}`

  const lead = reminder
    ? `This is a friendly reminder that <strong>${esc(senderName)}</strong> is waiting for your signature on <strong>${esc(docName)}</strong>.`
    : `<strong>${esc(senderName)}</strong> has requested your signature on <strong>${esc(docName)}</strong>.`

  const html = layout(
    h(reminder ? 'Reminder: your signature is requested' : 'Your signature is requested') +
      p(`Hi ${esc(recipientName)},`) +
      p(lead) +
      (message ? senderNote(message, senderName) : '') +
      button(signUrl, 'Review &amp; Sign', brand) +
      small(`If the button doesn't work, copy and paste this link into your browser:<br><span style="color:${BRAND_DARK};word-break:break-all;">${esc(signUrl)}</span>`),
    brand,
  )

  const text = [
    reminder ? 'Reminder: your signature is requested' : 'Your signature is requested',
    '',
    `Hi ${recipientName},`,
    '',
    reminder
      ? `This is a friendly reminder that ${senderName} is waiting for your signature on "${docName}".`
      : `${senderName} has requested your signature on "${docName}".`,
    '',
    ...(message ? [`Message from ${senderName}:`, message, ''] : []),
    `Review & sign: ${signUrl}`,
    '',
    `— ${brand?.name ?? 'Bevora Sign'}`,
  ].join('\n')

  return { subject, html, text }
}

// --- Completed (all recipients signed) ---------------------------------------

// ONE invitation per signer for an envelope: every document they need to sign,
// and their single link (/e/<token>) that lists them.
export function renderEnvelopeEmail(opts: {
  recipientName: string
  senderName: string
  envelopeName: string
  docNames: string[]
  envelopeUrl: string
  message?: string | null
  brand?: EmailBrand
}): RenderedEmail {
  const { recipientName, senderName, envelopeName, docNames, envelopeUrl, message, brand } = opts
  const n = docNames.length
  const noun = n === 1 ? 'document' : `${n} documents`
  const subject = `${senderName} has requested your signature on ${noun}: ${envelopeName}`

  const list =
    `<ul style="margin:0 0 16px;padding-left:20px;font-size:14px;line-height:1.6;color:${INK};">` +
    docNames.map((d) => `<li>${esc(d)}</li>`).join('') +
    '</ul>'

  const html = layout(
    h('Your signature is requested') +
      p(`Hi ${esc(recipientName)},`) +
      p(`<strong>${esc(senderName)}</strong> has requested your signature on ${n === 1 ? 'a document' : `${n} documents`} in <strong>${esc(envelopeName)}</strong>:`) +
      list +
      (message ? senderNote(message, senderName) : '') +
      button(envelopeUrl, n === 1 ? 'Review &amp; Sign' : 'Review &amp; Sign all', brand) +
      small(`If the button doesn't work, copy and paste this link into your browser:<br><span style="color:${BRAND_DARK};word-break:break-all;">${esc(envelopeUrl)}</span>`),
    brand,
  )

  const text = [
    'Your signature is requested',
    '',
    `Hi ${recipientName},`,
    '',
    `${senderName} has requested your signature on ${n === 1 ? 'a document' : `${n} documents`} in "${envelopeName}":`,
    ...docNames.map((d) => `  - ${d}`),
    '',
    ...(message ? [`Message from ${senderName}:`, message, ''] : []),
    `Review & sign: ${envelopeUrl}`,
    '',
    `— ${brand?.name ?? 'Bevora Sign'}`,
  ].join('\n')

  return { subject, html, text }
}

export function renderCompletedEmail(opts: {
  recipientName: string
  docName: string
  attached?: boolean
  appUrl?: string
  brand?: EmailBrand
}): RenderedEmail {
  const { recipientName, docName, attached, appUrl, brand } = opts
  const appName = brand?.name ?? 'Bevora Sign'
  const subject = `Completed: ${docName} is fully signed`

  const html = layout(
    h('Document completed') +
      p(`Hi ${esc(recipientName)},`) +
      p(`Everyone has signed <strong>${esc(docName)}</strong>. The document is now complete.`) +
      (attached ? p(`A copy of the signed document is attached to this email.`) : '') +
      (appUrl ? button(appUrl, `View in ${esc(appName)}`, brand) : ''),
    brand,
  )

  const text = [
    'Document completed',
    '',
    `Hi ${recipientName},`,
    '',
    `Everyone has signed "${docName}". The document is now complete.`,
    attached ? '\nA copy of the signed document is attached to this email.' : '',
    appUrl ? `\nView in ${appName}: ${appUrl}` : '',
    '',
    `— ${appName}`,
  ]
    .filter((l) => l !== '')
    .join('\n')

  return { subject, html, text }
}

// --- Declined -----------------------------------------------------------------

export function renderDeclinedEmail(opts: {
  senderName: string
  recipientName: string
  docName: string
  appUrl?: string
  brand?: EmailBrand
}): RenderedEmail {
  const { senderName, recipientName, docName, appUrl, brand } = opts
  const appName = brand?.name ?? 'Bevora Sign'
  const subject = `${recipientName} declined to sign ${docName}`

  const html = layout(
    h('A recipient declined to sign') +
      p(`Hi ${esc(senderName)},`) +
      p(`<strong>${esc(recipientName)}</strong> declined to sign <strong>${esc(docName)}</strong>. No further signatures can be collected on this document.`) +
      (appUrl ? button(appUrl, `View in ${esc(appName)}`, brand) : ''),
    brand,
  )

  const text = [
    'A recipient declined to sign',
    '',
    `Hi ${senderName},`,
    '',
    `${recipientName} declined to sign "${docName}". No further signatures can be collected on this document.`,
    appUrl ? `\nView in ${appName}: ${appUrl}` : '',
    '',
    `— ${appName}`,
  ]
    .filter((l) => l !== '')
    .join('\n')

  return { subject, html, text }
}

// --- Team invite (Settings → Team "Add user") --------------------------------

// A teammate was added to an org by its owner/admin. Carries the org name, the
// one-time temporary password, and a link to sign in. The temp password is the
// only secret here — it is shown once to the admin and (best-effort) emailed to
// the new user so they can log in and change it. Never logged.
export function renderTeamInviteEmail(opts: {
  recipientName: string
  inviterName: string
  orgName: string
  email: string
  tempPassword: string
  loginUrl?: string
  brand?: EmailBrand
}): RenderedEmail {
  const { recipientName, inviterName, orgName, email, tempPassword, loginUrl, brand } = opts
  const appName = brand?.name ?? 'Bevora Sign'
  const subject = `${inviterName} added you to ${orgName} on ${appName}`

  const creds =
    `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 4px;font-size:15px;line-height:1.7;color:${INK};">` +
    `<tr><td style="padding-right:12px;color:${MUTED};">Email</td><td><strong>${esc(email)}</strong></td></tr>` +
    `<tr><td style="padding-right:12px;color:${MUTED};">Temporary password</td><td><code style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;background:${SHELL};border:1px solid ${EDGE};border-radius:6px;padding:2px 8px;">${esc(tempPassword)}</code></td></tr>` +
    `</table>`

  const html = layout(
    h(`You've been added to ${esc(orgName)}`) +
      p(`Hi ${esc(recipientName)},`) +
      p(`<strong>${esc(inviterName)}</strong> added you to <strong>${esc(orgName)}</strong> on ${esc(appName)}. Sign in with these credentials and change your password after your first login.`) +
      creds +
      (loginUrl ? button(loginUrl, 'Sign in', brand) : '') +
      small('For your security, please change this temporary password once you sign in.'),
    brand,
  )

  const text = [
    `You've been added to ${orgName}`,
    '',
    `Hi ${recipientName},`,
    '',
    `${inviterName} added you to ${orgName} on ${appName}. Sign in with these credentials and change your password after your first login.`,
    '',
    `Email: ${email}`,
    `Temporary password: ${tempPassword}`,
    loginUrl ? `\nSign in: ${loginUrl}` : '',
    '',
    `— ${appName}`,
  ]
    .filter((l) => l !== '')
    .join('\n')

  return { subject, html, text }
}

// --- Test email (Settings → Email "Send test email") -------------------------

export function renderTestEmail(): RenderedEmail {
  const subject = 'Bevora Sign test email'
  const html = layout(
    h('SMTP is working') +
      p(`This is a test email from Bevora Sign. If you're reading this, your outbound email settings are configured correctly.`),
  )
  const text = [
    'SMTP is working',
    '',
    "This is a test email from Bevora Sign. If you're reading this, your outbound email settings are configured correctly.",
    '',
    '— Bevora Sign',
  ].join('\n')
  return { subject, html, text }
}
