// Bevora Sign brand mark: a signature stroke that resolves into a checkmark
// (sign → certified), carved as NEGATIVE SPACE out of the Bevora gold-gradient
// badge. The negative-space-on-gold construction is the core Bevora brand
// device (see the Bevora Design System README §2 — the "B" mark is built the
// same way), so the product mark reads as part of the family rather than a
// separate logo.
//
// The badge is a circle, matching the Bevora mark, and the gradient runs
// espresso → goldenrod → bright gold along the same 135° axis as the design
// system's `--grad-gold` token.
//
// Pure SVG, safe in server components. The pen-touchdown dot is dropped below
// 40px so the stroke stays crisp at small sizes.
//
// `gradientId` exists because two marks on one page (e.g. the signing shell
// header plus a footer) would otherwise emit duplicate SVG `id`s; duplicate
// ids are invalid and browsers resolve `url(#…)` to whichever came first.
export function BevoraSignMark({
  size = 32,
  tile = 'gradient',
  gradientId = 'bevoraSignGrad',
  className,
}: {
  size?: number
  tile?: 'gradient' | 'soft'
  gradientId?: string
  className?: string
}) {
  const showDot = size >= 40
  // Cream rather than pure white: the design system's warm neutral, so the
  // carved stroke sits on the gold without the cold edge #fff gives.
  const carve = '#faf9f7'
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 48 48"
      className={className}
      role="img"
      aria-label="Bevora Sign"
    >
      {tile === 'gradient' ? (
        <>
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1">
              <stop offset="0" stopColor="#2a2008" />
              <stop offset="0.38" stopColor="#6f4f0c" />
              <stop offset="0.74" stopColor="#b8860b" />
              <stop offset="1" stopColor="#cda42f" />
            </linearGradient>
          </defs>
          <circle cx="24" cy="24" r="24" fill={`url(#${gradientId})`} />
        </>
      ) : (
        // On an already-gold/espresso panel the badge would disappear, so the
        // `soft` tile is a translucent scrim instead of the gradient.
        <circle cx="24" cy="24" r="24" fill="rgba(255,255,255,0.14)" />
      )}
      <path
        d="M10 30 C 13 20, 21 20, 24 29 L 28.5 34 L 40 16.5"
        fill="none"
        stroke={carve}
        strokeWidth={3.6}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {showDot && <circle cx="10" cy="30" r="2.15" fill={carve} opacity={0.75} />}
    </svg>
  )
}

// Horizontal wordmark: "Bevora" in the current text colour, "Sign" in brand
// gold. Set in Sora (the design system's display face) via --font-display.
//
// Pass `onDark` when it sits on the espresso/gold brand panel, so "Sign" reads
// as pale gold against the dark ground instead of the too-close brand gold.
export function BevoraSignWordmark({
  className,
  onDark = false,
}: {
  className?: string
  onDark?: boolean
}) {
  return (
    <span
      className={`font-[family-name:var(--font-display)] font-semibold tracking-[-0.015em] ${className ?? ''}`}
    >
      <span>Bevora</span>
      <span className={onDark ? 'text-[#ead49a]' : 'text-brand-primary'}> Sign</span>
    </span>
  )
}
