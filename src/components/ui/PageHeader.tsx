import * as React from "react";
import Link from "next/link";

// Adapted from VirtualOffice's `components/ui/page-header.tsx`, themed to
// the Bevora palette.
//
// `subtitle` is a ReactNode, not a string: several settings pages set technical
// strings inline (`<code>/api/v1</code>`, `X-BevoraSign-Signature`) inside the
// subtitle copy, and forcing those to plain text would lose the mono treatment
// the design system reserves for them.
//
// `backHref` renders the "← Back to documents" affordance every settings page
// carried as its own hand-rolled block. Folding it in here is the point of the
// primitive — eight pages were each maintaining an identical copy of the same
// link/heading/subtitle markup, which is how they drifted off the palette in
// the first place.
export function PageHeader({
  title,
  subtitle,
  backHref,
  backLabel = "Back to documents",
  children,
}: {
  title: string;
  subtitle?: React.ReactNode;
  backHref?: string;
  backLabel?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="mb-6">
      {backHref && (
        <div className="mb-2">
          <Link
            href={backHref}
            className="text-[13px] text-brand-primary hover:underline"
          >
            ← {backLabel}
          </Link>
        </div>
      )}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[24px] leading-tight font-semibold text-ink sm:text-[26px]">
            {title}
          </h1>
          {subtitle && <p className="mt-1 text-[14px] text-muted">{subtitle}</p>}
        </div>
        {children && (
          <div className="flex flex-wrap items-center gap-2">{children}</div>
        )}
      </div>
    </div>
  );
}
