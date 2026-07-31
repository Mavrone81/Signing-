// Adapted from VirtualOffice's `components/ui/status-pill.tsx`, simplified
// for this app's two-state Document status (`draft` | `signed`) and
// re-implemented without the `next-intl` dependency (not installed here —
// this app has no i18n layer). Themed to the Bevora palette.
type Tone = "success" | "warn" | "danger" | "info" | "neutral";

const tones: Record<Tone, string> = {
  success: "bg-good/10 text-good",
  warn: "bg-warn/10 text-warn",
  danger: "bg-danger/10 text-danger",
  info: "bg-brand-accent/10 text-brand-accent-dark",
  neutral: "bg-edge text-muted",
};

const STATUS_TONE: Record<string, Tone> = {
  draft: "warn",
  signed: "success",
  sent: "info",
  completed: "success",
  declined: "danger",
};

const STATUS_LABEL: Record<string, string> = {
  draft: "Draft",
  signed: "Signed",
  sent: "Sent",
  completed: "Completed",
  declined: "Declined",
};

export function StatusPill({
  status,
  tone,
  label,
}: {
  status: string;
  tone?: Tone;
  label?: string;
}) {
  const toneCls = tone ?? STATUS_TONE[status] ?? "neutral";
  const text = label ?? STATUS_LABEL[status] ?? status;
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-1 text-[11px] font-medium ${tones[toneCls]}`}
    >
      {text}
    </span>
  );
}
