'use server'

import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { auth } from '@/auth'
import { MAX_LOGO_BYTES } from '@/lib/branding'
import { saveOrgBranding } from '@/server/branding/actions'

// Next form action for Settings → Branding. Thin wrapper: authenticate, parse
// the multipart form, delegate the org-admin gate + validation + tenant-scoped
// persistence to saveOrgBranding, then redirect. The org is always taken from
// the SESSION (never the form) so one org can't write another's branding.
export async function saveBranding(formData: FormData): Promise<void> {
  const session = await auth()
  const actor = {
    orgId: session?.user?.orgId ?? null,
    orgRole: session?.user?.orgRole ?? null,
  }

  const brandName = String(formData.get('brandName') ?? '')
  const brandColor = String(formData.get('brandColor') ?? '')
  const removeLogo = formData.get('removeLogo') === '1'

  let logo: Buffer | undefined
  const file = formData.get('logo')
  if (file instanceof File && file.size > 0) {
    // Fast size reject before buffering (the core re-checks authoritatively).
    if (file.size > MAX_LOGO_BYTES) redirect('/settings/branding?error=size')
    logo = Buffer.from(await file.arrayBuffer())
  }

  const res = await saveOrgBranding(actor, { brandName, brandColor, logo, removeLogo })
  if (!res.ok) {
    if (res.error === 'FORBIDDEN') redirect('/documents')
    redirect(`/settings/branding?error=${res.error}`)
  }

  revalidatePath('/settings/branding')
  revalidatePath('/', 'layout')
  redirect('/settings/branding?saved=1')
}
