'use server'

import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { auth } from '@/auth'
import { prisma } from '@/lib/db'
import { uid } from '@/lib/uid'
import {
  encryptSecret,
  invalidateProviderCache,
  isPlatformAdmin,
  OAUTH_PROVIDERS,
  type OAuthProvider,
} from '@/lib/auth-providers'

// Platform-admin-gated upsert of one provider's OAuth config. The client secret
// is WRITE-ONLY: an empty field means "keep the stored secret unchanged" (the
// UI never receives the secret to re-post). Supplied secrets are encrypted
// (AES-256-GCM) before they touch the DB and are never logged.
export async function saveProviderConfig(formData: FormData): Promise<void> {
  const session = await auth()
  // Re-check the gate on write — never trust that the page render gated it.
  if (!isPlatformAdmin(session)) redirect('/documents')

  const provider = String(formData.get('provider') ?? '')
  if (!(OAUTH_PROVIDERS as readonly string[]).includes(provider)) {
    redirect('/settings/authentication?error=1')
  }

  const clientId = String(formData.get('clientId') ?? '').trim()
  const clientSecret = String(formData.get('clientSecret') ?? '')
  const tenantId = String(formData.get('tenantId') ?? '').trim()
  // An unchecked checkbox is simply absent from the form data.
  const enabled = formData.get('enabled') != null

  const secretEnc = clientSecret.length > 0 ? encryptSecret(clientSecret) : undefined

  await prisma.authProviderConfig.upsert({
    where: { provider },
    update: {
      enabled,
      clientId: clientId || null,
      tenantId: tenantId || null,
      updatedBy: session!.user.id,
      // Only overwrite the secret when a new one was supplied.
      ...(secretEnc !== undefined ? { clientSecretEnc: secretEnc } : {}),
    },
    create: {
      id: uid(),
      provider: provider as OAuthProvider,
      enabled,
      clientId: clientId || null,
      tenantId: tenantId || null,
      clientSecretEnc: secretEnc ?? null,
      updatedBy: session!.user.id,
    },
  })

  // Drop the ~30s TTL cache so the change is live on the next request.
  invalidateProviderCache()
  revalidatePath('/settings/authentication')
  redirect(`/settings/authentication?saved=${provider}`)
}
