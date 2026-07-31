"use client";

import { useState } from "react";
import type { Document, RecipientStatus } from "@prisma/client";
import { Card } from "@/components/ui/Card";
import { StatusPill } from "@/components/ui/StatusPill";
import { buttonClasses } from "@/components/ui/Button";
import { formatDateSGT } from "@/lib/format";

// A document as the dashboard renders it: the row plus its recipients' statuses
// (for the "N of M signed" progress indicator).
export type DashboardDocument = Document & {
  recipients: { status: RecipientStatus }[];
};

// Sent/completed documents show recipient progress.
const PROGRESS_STATUSES = new Set(["sent", "completed"]);

function EmptyState({ activeStatus, query }: { activeStatus: string; query: string }) {
  const filtered = activeStatus !== "all" || query !== "";
  return (
    <Card className="flex flex-col items-center gap-1 px-6 py-12 text-center">
      <p className="text-[14px] font-medium text-ink">
        {filtered ? "No matching documents" : "No documents yet"}
      </p>
      <p className="text-[13px] text-muted">
        {query
          ? `No documents match “${query}”.`
          : activeStatus !== "all"
            ? `You have no ${activeStatus} documents.`
            : "Upload a PDF above to get started."}
      </p>
    </Card>
  );
}

export function DocumentList({
  documents,
  activeStatus = "all",
  query = "",
}: {
  documents: DashboardDocument[];
  activeStatus?: string;
  query?: string;
}) {
  const [items, setItems] = useState(documents);
  // Per-document transient state: 'deleting' while in flight, or an error message.
  const [busy, setBusy] = useState<Record<string, string>>({});

  const remove = async (doc: DashboardDocument) => {
    // A sent/in-progress document's recipients still hold a live signing link
    // (/sign/[token]); deleting cascades their Recipient rows, so that link
    // stops working. Warn distinctly for that case — otherwise it's just an
    // irreversible delete.
    const message =
      doc.status === "sent"
        ? "This document has been sent for signature. Deleting it now is permanent — pending signers will lose access to their signing link. Delete anyway?"
        : "Delete this document? This is permanent and cannot be undone.";
    if (!window.confirm(message)) return;

    setBusy((b) => ({ ...b, [doc.id]: "deleting" }));
    try {
      const res = await fetch(`/api/documents/${doc.id}`, { method: "DELETE" });
      if (!res.ok) {
        setBusy((b) => ({ ...b, [doc.id]: `Could not delete (${res.status}).` }));
        return;
      }
      setItems((list) => list.filter((d) => d.id !== doc.id));
    } catch {
      setBusy((b) => ({ ...b, [doc.id]: "Network error. Please try again." }));
    }
  };

  if (items.length === 0) {
    return <EmptyState activeStatus={activeStatus} query={query} />;
  }

  const now = Date.now();

  return (
    <ul className="flex flex-col gap-3">
      {items.map((doc) => {
        const total = doc.recipients.length;
        const signed = doc.recipients.filter((r) => r.status === "signed").length;
        const showProgress = PROGRESS_STATUSES.has(doc.status) && total > 0;
        // Flag a still-open (sent) document whose deadline has passed.
        const isExpired =
          doc.status === "sent" && !!doc.expiresAt && doc.expiresAt.getTime() < now;
        const state = busy[doc.id];
        const deleting = state === "deleting";
        const error = state && !deleting ? state : null;

        return (
          <li key={doc.id}>
            <Card className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="truncate text-[14px] font-medium text-ink">
                    {doc.originalName}
                  </p>
                  <StatusPill status={doc.status} />
                  {isExpired && (
                    <StatusPill status="expired" tone="danger" label="Expired" />
                  )}
                  {showProgress && (
                    <span className="text-[12px] font-medium text-muted">
                      {signed} of {total} signed
                    </span>
                  )}
                </div>
                <p className="mt-1 text-[12px] text-muted">
                  Uploaded {formatDateSGT(doc.createdAt)}
                  {doc.pageCount
                    ? ` · ${doc.pageCount} page${doc.pageCount === 1 ? "" : "s"}`
                    : ""}
                  {doc.expiresAt
                    ? ` · ${isExpired ? "Expired" : "Expires"} ${formatDateSGT(doc.expiresAt)}`
                    : ""}
                </p>
                {error && (
                  <p className="mt-1 text-[12px] text-danger" role="alert">
                    {error}
                  </p>
                )}
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <a
                  href={`/documents/${doc.id}/edit`}
                  className={buttonClasses("secondary", "sm")}
                >
                  {doc.status === "draft" ? "Edit" : "View"}
                </a>
                <a
                  href={`/api/documents/${doc.id}/file/original`}
                  className={buttonClasses("ghost", "sm")}
                >
                  Download original
                </a>
                {doc.status !== "draft" && (
                  <a
                    href={`/api/documents/${doc.id}/audit`}
                    className={buttonClasses("ghost", "sm")}
                  >
                    Audit trail
                  </a>
                )}
                {(doc.status === "signed" || doc.status === "completed") && (
                  <a
                    href={`/api/documents/${doc.id}/file/signed`}
                    className={buttonClasses("primary", "sm")}
                  >
                    Download signed
                  </a>
                )}
                <button
                  type="button"
                  className={buttonClasses("ghost", "sm", "text-danger hover:bg-danger/10")}
                  onClick={() => remove(doc)}
                  disabled={deleting}
                  aria-label={`Delete ${doc.originalName}`}
                >
                  {deleting ? "Deleting…" : "Delete"}
                </button>
              </div>
            </Card>
          </li>
        );
      })}
    </ul>
  );
}
