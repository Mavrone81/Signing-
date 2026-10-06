'use server'

import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { auth } from '@/auth'
import { prisma } from '@/lib/db'
import { uid } from '@/lib/uid'
import { isPlatformAdmin } from '@/lib/auth-providers'
import { canManageOrgSettings } from '@/lib/org-settings'
import { encryptSecret, invalidateEmailConfigCache, EMAIL_PROVIDER } from '@/lib/email-config'
import { sendEmail } from '@/lib/mailer'
import { renderTestEmail } from '@/lib/email-templates'
import { parseEmailRecipient } from '@/lib/email-recipient'

// Parsed SMTP fields from the settings form. The password is WRITE-ONLY: an
// empty field means "keep the stored password" (the UI never receives it to
// re-post), so `passwordEnc` is undefined when none was supplied. Supplied
// passwords are AES-256-GCM encrypted before they touch the DB, never logged.
function readSmtpForm(formData: FormData) {
  const portRaw = String(formData.get('port') ?? '').trim()
  const port = portRaw ? Number.parseInt(portRaw, 10) : null
  const password = String(formData.get('password') ?? '')
  const str = (k: string) => String(formData.get(k) ?? '').trim() || null
  return {
    portOk: port == null || (Number.isInteger(port) && port >= 1 && port <= 65535),
    fields: {
      // Unchecked checkboxes are simply absent from the form data.
      enabled: formData.get('enabled') != null,
      host: str('host'),
      port,
      secure: formData.get('secure') != null,
      username: str('username'),
      fromName: str('fromName'),
      fromEmail: str('fromEmail'),
    },
    passwordEnc: password.length > 0 ? encryptSecret(password) : undefined,
  }
}

// Save the caller's ORG's own SMTP server. Re-checks the org-settings gate on
// write (never trusting the page) and takes the org from the SESSION, never from
// the form, so one org's admin can't write another org's server.
export async function saveEmailConfig(formData: FormData): Promise<void> {
  const session = await auth()
  const user = session?.user
  if (!canManageOrgSettings(user)) redirect('/documents')
  const orgId = user.orgId

  const { portOk, fields, passwordEnc } = readSmtpForm(formData)
  if (!portOk) redirect('/settings/email?error=port')

  await prisma.emailConfig.upsert({
    where: { orgId },
    update: {
      ...fields,
      updatedBy: session!.user.id,
      ...(passwordEnc !== undefined ? { passwordEnc } : {}),
    },
    create: {
      id: uid(),
      orgId,
      provider: EMAIL_PROVIDER,
      ...fields,
      passwordEnc: passwordEnc ?? null,
      updatedBy: session!.user.id,
    },
  })

  // Only this org's resolution changed.
  invalidateEmailConfigCache(orgId)
  revalidatePath('/settings/email')
  redirect('/settings/email?saved=org')
}

// Save the SHARED fallback server (the row with no org). Platform admins only.
export async function saveSharedEmailConfig(formData: FormData): Promise<void> {
  const session = await auth()
  if (!isPlatformAdmin(session)) redirect('/documents')

  const { portOk, fields, passwordEnc } = readSmtpForm(formData)
  if (!portOk) redirect('/settings/email?error=port')

  // At most one shared row: update the existing one, else create it.
  const existing = await prisma.emailConfig.findFirst({ where: { orgId: null }, select: { id: true } })
  if (existing) {
    await prisma.emailConfig.update({
      where: { id: existing.id },
      data: {
        ...fields,
        updatedBy: session!.user.id,
        ...(passwordEnc !== undefined ? { passwordEnc } : {}),
      },
    })
  } else {
    await prisma.emailConfig.create({
      data: {
        id: uid(),
        provider: EMAIL_PROVIDER,
        ...fields,
        passwordEnc: passwordEnc ?? null,
        updatedBy: session!.user.id,
      },
    })
  }

  // Every org that falls back to the shared server is affected.
  invalidateEmailConfigCache()
  revalidatePath('/settings/email')
  redirect('/settings/email?saved=shared')
}

// Send a test email AS the caller's org, to the SIGNED-IN ACCOUNT'S OWN ADDRESS.
// The outcome, the recipient and the server that carried it come back as query
// params; the page validates `to` again before showing it.
//
// The recipient is deliberately NOT a parameter. A test email exists to prove
// the caller's own settings work, and only their own inbox tells them that —
// delivery to someone else proves nothing to the person who asked for it, and is
// mail that person never requested. Taking it from the session rather than the
// form also means the destination cannot be chosen by whatever reaches this
// function, independently of what the page renders.
export async function sendTestEmail(_formData: FormData): Promise<void> {
  const session = await auth()
  const user = session?.user
  if (!canManageOrgSettings(user)) redirect('/documents')

  const to = parseEmailRecipient(session!.user.email ?? '')
  if (!to) {
    redirect('/settings/email?test=fail&reason=no_admin_email')
  }
  const q = `to=${encodeURIComponent(to)}`

  // A fresh save may still be within the config cache TTL — drop this org's
  // entry so the test reflects the just-saved settings.
  invalidateEmailConfigCache(user.orgId)
  const result = await sendEmail({ orgId: user.orgId, to, ...renderTestEmail() })

  if (result.sent) redirect(`/settings/email?test=ok&${q}&via=${result.via}`)
  redirect(`/settings/email?test=fail&reason=${result.reason}&${q}${result.via ? `&via=${result.via}` : ''}`)
}
