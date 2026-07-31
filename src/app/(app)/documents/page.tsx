import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Prisma } from "@prisma/client";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { PageHeader } from "@/components/ui/PageHeader";
import { UploadDropzone } from "@/components/documents/UploadDropzone";
import { DocumentList } from "@/components/documents/DocumentList";
import { DashboardFilters } from "@/components/documents/DashboardFilters";

export const metadata: Metadata = { title: "Documents · Bevora Sign" };

// This page queries Prisma directly in the server component, so it must be
// force-dynamic: without it, `next build` would try to prerender the page
// at build time with no DB available and fail.
export const dynamic = "force-dynamic";

// The status filter tabs. `all` clears the status filter; every other key maps
// to a DocStatus and filters server-side.
const STATUS_FILTERS = [
  "all",
  "draft",
  "sent",
  "completed",
  "signed",
  "declined",
] as const;
type StatusFilter = (typeof STATUS_FILTERS)[number];

function normalizeStatus(raw: string | undefined): StatusFilter {
  return STATUS_FILTERS.includes(raw as StatusFilter) ? (raw as StatusFilter) : "all";
}

export default async function DocumentsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; q?: string }>;
}) {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const sp = await searchParams;
  const status = normalizeStatus(sp.status);
  const q = (sp.q ?? "").trim();

  // Tenant scope: only this org's docs. Org owners/admins see all of them; a
  // plain member sees only their own. A user with no org sees nothing.
  const isOrgAdmin =
    session.user.orgRole === "owner" || session.user.orgRole === "admin";

  const where: Prisma.DocumentWhereInput = {
    orgId: session.user.orgId ?? "",
    ...(isOrgAdmin ? {} : { ownerId: session.user.id }),
    // Status filter (server-side): `all` applies none.
    ...(status !== "all" ? { status } : {}),
    // Case-insensitive name search (server-side).
    ...(q ? { originalName: { contains: q, mode: "insensitive" as const } } : {}),
  };

  const documents = session.user.orgId
    ? await prisma.document.findMany({
        where,
        orderBy: { createdAt: "desc" },
        // Recipient statuses drive the "N of M signed" progress indicator.
        include: { recipients: { select: { status: true } } },
      })
    : [];

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6 lg:px-8">
      <PageHeader
        title="Documents"
        subtitle="Upload a PDF, then place signature, date, and text fields."
      />
      <UploadDropzone />
      <DashboardFilters status={status} q={q} />
      <DocumentList documents={documents} activeStatus={status} query={q} />
    </div>
  );
}
