import Link from "next/link";
import { redirect } from "next/navigation";
import { auth, signOut } from "@/auth";
import { prisma } from "@/lib/db";
import { resolveBrand } from "@/lib/branding";
import { BevoraSignMark, BevoraSignWordmark } from "@/components/brand/BevoraSignMark";

// Shared shell for all authed pages (only `/documents` today; `/documents/[id]/edit`
// lands in Task 10). Defensive redirect in addition to `src/middleware.ts` —
// keeps this layout safe even if the middleware matcher ever changes.
export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();
  if (!session?.user) redirect("/login");

  // Phase 5 — the member's org brand (secondary in-app; the Bevora Sign mark stays
  // the product identity). A `null` org (no membership) degrades to no chip.
  const orgRole = session.user.orgRole;
  const canEditBranding = orgRole === "owner" || orgRole === "admin";
  const org = session.user.orgId
    ? await prisma.organization.findUnique({
        where: { id: session.user.orgId },
        select: { name: true, brandName: true, brandColor: true, logoKey: true },
      })
    : null;
  const brand = org ? resolveBrand(org) : null;

  return (
    <div className="min-h-screen bg-shell">
      <header className="border-b border-edge bg-paper">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-3 px-4 py-3 sm:px-6 lg:px-8">
          <Link href="/documents" className="flex items-center gap-2.5" aria-label="Bevora Sign — documents">
            <BevoraSignMark size={30} />
            <BevoraSignWordmark className="text-[15px] text-ink" />
            {brand?.customized && (
              <span className="ml-1 flex items-center gap-1.5 border-l border-edge pl-2.5">
                {brand.hasLogo && org ? (
                  // eslint-disable-next-line @next/next/no-img-element -- org-gated logo route
                  <img
                    src={`/api/branding/${session.user.orgId}/logo`}
                    alt={brand.name}
                    className="h-5 w-auto max-w-[120px] object-contain"
                  />
                ) : (
                  <>
                    <span
                      className="h-2.5 w-2.5 rounded-full"
                      style={{ backgroundColor: brand.color }}
                      aria-hidden
                    />
                    <span className="hidden text-[13px] font-medium text-muted sm:inline">
                      {brand.name}
                    </span>
                  </>
                )}
              </span>
            )}
          </Link>
          <div className="flex items-center gap-3">
            <Link
              href="/documents"
              className="text-[13px] font-medium text-ink transition-colors hover:text-brand-primary"
            >
              Documents
            </Link>
            <Link
              href="/templates"
              className="text-[13px] font-medium text-ink transition-colors hover:text-brand-primary"
            >
              Templates
            </Link>
            {canEditBranding && (
              <>
                <Link
                  href="/settings/team"
                  className="text-[13px] font-medium text-ink transition-colors hover:text-brand-primary"
                >
                  Team
                </Link>
                <Link
                  href="/settings/branding"
                  className="text-[13px] font-medium text-ink transition-colors hover:text-brand-primary"
                >
                  Branding
                </Link>
                <Link
                  href="/settings/api-keys"
                  className="text-[13px] font-medium text-ink transition-colors hover:text-brand-primary"
                >
                  API keys
                </Link>
                <Link
                  href="/settings/webhooks"
                  className="text-[13px] font-medium text-ink transition-colors hover:text-brand-primary"
                >
                  Webhooks
                </Link>
              </>
            )}
            {session.user.isPlatformAdmin && (
              <>
                <Link
                  href="/settings/organizations"
                  className="text-[13px] font-medium text-ink transition-colors hover:text-brand-primary"
                >
                  Organizations
                </Link>
                <Link
                  href="/settings/authentication"
                  className="text-[13px] font-medium text-ink transition-colors hover:text-brand-primary"
                >
                  Settings
                </Link>
                <Link
                  href="/settings/email"
                  className="text-[13px] font-medium text-ink transition-colors hover:text-brand-primary"
                >
                  Email
                </Link>
                <Link
                  href="/settings/signing"
                  className="text-[13px] font-medium text-ink transition-colors hover:text-brand-primary"
                >
                  Signing
                </Link>
              </>
            )}
            <span className="hidden truncate text-[13px] text-muted sm:inline">
              {session.user.email}
            </span>
            <form
              action={async () => {
                "use server";
                await signOut({ redirectTo: "/login" });
              }}
            >
              <button
                type="submit"
                className="min-h-11 rounded-lg border border-edge-strong px-3 text-[13px] font-medium text-ink transition-colors hover:bg-shell"
              >
                Sign out
              </button>
            </form>
          </div>
        </div>
      </header>
      <main>{children}</main>
    </div>
  );
}
