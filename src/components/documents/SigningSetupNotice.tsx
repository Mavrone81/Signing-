import Link from 'next/link'
import { isSigningConfigured } from '@/lib/signing-config'
import { canManageOrgSettings } from '@/lib/org-settings'

/**
 * Prompts an org's owner/admin to set up a signing certificate while the org has
 * none.
 *
 * WHY IT EXISTS: without a certificate, finalizing still produces a perfectly
 * usable document — fields are flattened, the audit certificate page is
 * appended, the signature is visible — it simply carries no PAdES seal, so it is
 * not tamper-evident and does not verify in a PDF reader. `maybePadesSign`
 * returns the bytes unsealed and logs, by design, so nothing fails and nobody is
 * told. That is the right behaviour for a send that is already in flight and the
 * wrong behaviour for an org that has never set one up: the gap is invisible
 * precisely because it degrades so gracefully.
 *
 * NOT A BLOCKER, deliberately. An org that wants to get a document signed in its
 * first five minutes can. This states the consequence and offers the fix; it
 * does not stand in the way of the thing the user came to do.
 *
 * Shown ONLY to someone who can act on it. A member who cannot reach
 * Settings → Signing would get a warning about something they cannot fix, which
 * is noise they will learn to scroll past — and that habit costs more than this
 * notice is worth.
 */
export async function SigningSetupNotice({
  user,
}: {
  user: { orgId?: string | null; orgRole?: string | null; isPlatformAdmin?: boolean } | null | undefined
}) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if (!canManageOrgSettings(user as any)) return null
  const orgId = user!.orgId as string
  if (await isSigningConfigured(orgId)) return null

  return (
    <div
      role="status"
      className="mb-6 rounded-xl border border-warn/30 bg-warn/5 px-4 py-3 text-[13px] text-ink"
    >
      <p className="font-medium">Set up your signing certificate</p>
      <p className="mt-1 text-muted">
        Until you do, documents you finalize are still signed and still carry their audit
        certificate — but they are not sealed, so a reader cannot verify they are unaltered.
        Generating one takes a moment and you can replace it whenever you like.
      </p>
      <Link
        href="/settings/signing"
        className="mt-2 inline-block rounded-lg border border-edge-strong px-3 py-1.5 text-[13px] font-medium text-ink transition-colors hover:bg-shell"
      >
        Generate a certificate
      </Link>
    </div>
  )
}
