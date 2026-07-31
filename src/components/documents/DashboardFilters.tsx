import Link from "next/link";

// Server-rendered dashboard controls: status filter pills (links that set the
// `?status=` search param) + a name search box (a GET form that sets `?q=`).
// Both drive server-side filtering in the documents page — no client JS needed.

const FILTERS: { key: string; label: string }[] = [
  { key: "all", label: "All" },
  { key: "draft", label: "Draft" },
  { key: "sent", label: "Sent" },
  { key: "completed", label: "Completed" },
  { key: "signed", label: "Signed" },
  { key: "declined", label: "Declined" },
];

export function DashboardFilters({ status, q }: { status: string; q: string }) {
  return (
    <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <nav className="flex flex-wrap gap-2" aria-label="Filter by status">
        {FILTERS.map((f) => {
          const active = f.key === status;
          // Preserve the current search query when switching status.
          const params = new URLSearchParams();
          if (f.key !== "all") params.set("status", f.key);
          if (q) params.set("q", q);
          const href = params.toString() ? `/documents?${params}` : "/documents";
          return (
            <Link
              key={f.key}
              href={href}
              aria-current={active ? "page" : undefined}
              className={`inline-flex min-h-9 items-center rounded-full border px-3 text-[13px] font-medium transition-colors ${
                active
                  ? "border-brand-primary bg-brand-primary text-white"
                  : "border-edge-strong bg-paper text-muted hover:text-ink"
              }`}
            >
              {f.label}
            </Link>
          );
        })}
      </nav>

      <form method="get" action="/documents" className="flex items-center gap-2">
        {/* Keep the active status filter when searching. */}
        {status !== "all" && <input type="hidden" name="status" value={status} />}
        <input
          type="search"
          name="q"
          defaultValue={q}
          placeholder="Search by name…"
          aria-label="Search documents by name"
          className="min-h-9 w-full rounded-lg border border-edge-strong bg-paper px-3 text-[13px] text-ink outline-none focus-visible:ring-2 focus-visible:ring-brand-primary/40 sm:w-56"
        />
      </form>
    </div>
  );
}
