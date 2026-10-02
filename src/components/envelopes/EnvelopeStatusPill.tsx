import type { EnvelopeStatus } from '@/lib/envelopes'

// Envelope status is derived from its documents (src/lib/envelopes.ts); the
// label always carries the meaning, the tone only reinforces it.
const LOOK: Record<EnvelopeStatus, { label: string; tone: string }> = {
  draft: { label: 'Draft', tone: 'bg-warn-tint text-ink' },
  partial: { label: 'Partly sent', tone: 'bg-brand-primary-tint text-brand-accent' },
  sent: { label: 'Sent', tone: 'bg-brand-primary-tint text-brand-accent' },
  completed: { label: 'Completed', tone: 'bg-good-tint text-ink' },
}

export function EnvelopeStatusPill({ status }: { status: EnvelopeStatus }) {
  const l = LOOK[status]
  return <span className={`inline-block rounded-full px-2.5 py-1 text-[12px] font-medium ${l.tone}`}>{l.label}</span>
}
