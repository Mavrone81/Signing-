import Link from 'next/link'
import { prisma } from '@/lib/db'
import { isSigningConfigured } from '@/lib/signing-config'
import { canManageOrgSettings } from '@/lib/org-settings'
import { generatePlatformCertificate } from '@/app/(app)/settings/signing/actions'

/**
 * Prompts an org's owner/admin to set up a signing certificate while the org has
 * none, and lets them do it from here in one click.
 *
 * WHY IT EXISTS: without a certificate, finalizing still produces a perfectly
 * usable document — fields are flattened, the audit certificate page is
 * appended, the signature is visible — it simply carries no PAdES seal, so it is
 * not tamper-evident and does not verify in a PDF reader. `maybePadesSign`
 * returns the bytes unsealed and logs, by design, so nothing fails and nobody is
 * told. That is the right behaviour for a send already in flight and the wrong
 * behaviour for an org that has never set one up: the gap is invisible precisely
 * because it degrades so gracefully.
 *
 * THE BUTTON IS HERE, not just a link to settings. Someone who has to navigate
 * to a settings page to act on a prompt mostly does not, and this is the one
 * step that decides whether their documents are verifiable.
 *
 * The certificate is issued in the ORGANIZATION'S OWN NAME. That string is what
 * a recipient sees in their PDF reader's signature panel, so it has to say who
 * actually signed — a certificate issued in the product's name would misstate
 * that on every document the org ever sends. Settings remains the place to
 * choose a different name or validity, or to upload one from a real CA.
 *
 * NOT A BLOCKER, deliberately. An org that wants a document signed in its first
 * five minutes can.
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

  const org = await prisma.organization.findUnique({ where: { id: orgId }, select: { name: true } })
  const signerName = org?.name?.trim() ?? ''

  return (
    <div
      role="status"
      className="mb-6 rounded-xl border border-warn/30 bg-warn/5 px-4 py-3 text-[13px] text-ink"
    >
      <p className="font-medium">Set up your signing certificate</p>
      <p className="mt-1 text-muted">
        Until you do, documents you finalize are still signed and still carry their audit
        certificate — but they are not sealed, so a reader cannot verify they are unaltered.
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <form action={generatePlatformCertificate}>
          {/* Sent explicitly rather than relying on the action's own fallback, so
              what this button promises and what it does cannot drift apart. */}
          <input type="hidden" name="commonName" value={signerName} />
          <button
            type="submit"
            className="rounded-lg bg-brand-primary px-3 py-1.5 text-[13px] font-medium text-white transition-opacity hover:opacity-90"
          >
            Generate a certificate
          </button>
        </form>
        <Link
          href="/settings/signing"
          className="text-[13px] font-medium text-muted underline-offset-2 hover:underline"
        >
          Choose a different name or upload your own
        </Link>
      </div>
      {signerName && (
        <p className="mt-2 text-[12px] text-muted">
          Signed as <span className="font-medium text-ink">{signerName}</span> — the name recipients
          see in their PDF reader. Valid for 3 years; you can replace it at any time.
        </p>
      )}
    </div>
  )
}
