import * as React from "react";

// Adapted from VirtualOffice's `components/ui/card.tsx`, themed to the
// Bevora palette (`--edge`, `--paper`) defined in `src/app/globals.css`.
export function Card({
  className = "",
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={`rounded-xl border border-edge bg-paper shadow-sm ${className}`}
      {...props}
    />
  );
}
