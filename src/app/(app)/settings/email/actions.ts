'use server'

import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { auth } from '@/auth'
import { prisma } from '@/lib/db'
import { uid } from '@/lib/uid'
import { isPlatformAdmin } from '@/lib/auth-providers'
import { encryptSecret, invalidateEmailConfigCache, EMAIL_PROVIDER } from '@/lib/email-config'
import { sendEmail } from '@/lib/mailer'
import { renderTestEmail } from '@/lib/email-templates'

// Platform-admin-gated upsert of the singleton SMTP config. The password is
// WRITE-ONLY: an empty field means "keep the stored password" (the UI never
// receives it to re-post). Supplied passwords are AES-256-GCM encrypted before
// they touch the DB and are never logged.
export async function saveEmailConfig(formData: FormData): Promise<void> {
  const session = await auth()
  // Re-check the gate on write — never trust that the page render gated it.
  if (!isPlatformAdmin(session)) redirect('/documents')

  const host = String(formData.get('host') ?? '').trim()
  const portRaw = String(formData.get('port') ?? '').trim()
  const port = portRaw ? Number.parseInt(portRaw, 10) : null
  const username = String(formData.get('username') ?? '').trim()
  const password = String(formData.get('password') ?? '')
  const fromName = String(formData.get('fromName') ?? '').trim()
  const fromEmail = String(formData.get('fromEmail') ?? '').trim()
  // Unchecked checkboxes are simply absent from the form data.
  const enabled = formData.get('enabled') != null
  const secure = formData.get('secure') != null

  if (port != null && (!Number.isInteger(port) || port < 1 || port > 65535)) {
    redirect('/settings/email?error=port')
  }

  const passwordEnc = password.length > 0 ? encryptSecret(password) : undefined

  await prisma.emailConfig.upsert({
    where: { provider: EMAIL_PROVIDER },
    update: {
      enabled,
      host: host || null,
      port,
      secure,
      username: username || null,
      fromName: fromName || null,
      fromEmail: fromEmail || null,
      updatedBy: session!.user.id,
      // Only overwrite the password when a new one was supplied.
      ...(passwordEnc !== undefined ? { passwordEnc } : {}),
    },
    create: {
      id: uid(),
      provider: EMAIL_PROVIDER,
      enabled,
      host: host || null,
      port,
      secure,
      username: username || null,
      passwordEnc: passwordEnc ?? null,
      fromName: fromName || null,
      fromEmail: fromEmail || null,
      updatedBy: session!.user.id,
    },
  })

  // Drop the ~30s TTL cache so the change is live on the next send.
  invalidateEmailConfigCache()
  revalidatePath('/settings/email')
  redirect('/settings/email?saved=1')
}

// Platform-admin-gated: send a test email to the admin's own address and report
// the outcome via a redirect query param.
export async function sendTestEmail(): Promise<void> {
  const session = await auth()
  if (!isPlatformAdmin(session)) redirect('/documents')

  const to = session!.user.email
  if (!to) redirect('/settings/email?test=fail&reason=no_admin_email')

  // A fresh save may still be within the config cache TTL — drop it so the test
  // reflects the just-saved settings.
  invalidateEmailConfigCache()
  const rendered = renderTestEmail()
  const result = await sendEmail({ to, ...rendered })

  if (result.sent) redirect('/settings/email?test=ok')
  redirect(`/settings/email?test=fail&reason=${result.reason}`)
}
