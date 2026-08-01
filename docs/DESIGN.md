# Design — Bevora brand adherence

This app follows the **Bevora Design System**, the same one behind bevorasg.com.
Source of truth: `Bevora Design System/` inside the bevoraWEB working copy
(`README.md`, `tokens/*.css`, `components/`, `guidelines/*.card.html`). Read it;
never edit bevoraWEB itself.

## The token contract

`src/app/globals.css` is the only place colour is defined. It carries the design
system's values under **this app's own semantic names** — `--paper`, `--shell`,
`--ink`, `--muted`, `--edge`, `--brand-primary`, `--good` / `--warn` /
`--danger` / `--info` and their `-tint` washes — mapped into Tailwind through
`@theme inline`.

That indirection is deliberate: the rebrand from the app's previous scheme
changed only the *values* in this file, and every component that already read
the semantic names picked it up with no edit. Keep it that way — components
reference semantic names, never the raw `--gold-*` / `--neutral-*` ramp.

**If you need a colour that has no token, add the token.** The settings pages
drifted onto raw Tailwind palette classes (`bg-red-50`, `border-amber-300`)
purely because there was no wash token for an alert background. An eslint rule
now fails the build on those classes.

Conventions in use:

| Thing | Classes |
|---|---|
| Block callout (alert) | `border-<status>/35 bg-<status>-tint text-ink` |
| Pill / badge | `bg-<status>/10 text-<status>` (see `StatusPill`) |
| Destructive button | `border-danger/40 text-danger hover:bg-danger-tint` |

Callout body copy stays `text-ink`: `--warn` on `--warn-tint` measures 2.45:1,
far below AA. The wash and border carry the semantic; the text stays legible —
which also matches the design system's rule that warm neutrals carry content
and colour is only a signal.

**Gold (`--brand-primary`, `#b8860b`) is a signal colour.** It carries primary
actions, focus rings and brand marks. It must not fill large surfaces.

## Type

Sora (display/headings, `--font-display`) · Manrope (UI/body, `--font-sans`) ·
JetBrains Mono (hashes, ids, timestamps, `--font-mono`). Self-hosted through
`next/font` in `src/app/layout.tsx` — deliberately *not* the design system's
Google Fonts `@import`, so the app makes no external font request at runtime.

## Icons

The app currently has **no UI icons**, and `lucide-react` is intentionally not a
dependency. Every `<svg>` in `src/` is a brand mark: the product mark
(`BevoraSignMark`, `icon.svg`) and the official Google / Microsoft logos on the
SSO buttons — vendor logos must stay the official artwork with their exact
brand colours, which is not something an icon library should supply.

**When you add the first real UI icon, use `lucide-react`** (stroke style) —
that is the design system's icon set. Do not hand-roll one.

## Why the design system's lint config is not wired up

`Bevora Design System/_adherence.oxlintrc.json` is an **oxlint** config; this
repo lints with eslint, and two of its three rules do not fit:

- it bans raw `px` — this codebase deliberately sets `text-[13px]` and friends;
- it bans raw hex — legitimately required for Google/Microsoft's exact brand
  colours, the gold gradient stops in `BevoraSignMark`, and `lib/email-templates.ts`,
  where hex is **mandatory** because email clients do not support CSS variables.

Its one rule that does fit — no off-palette colour — is ported into
`eslint.config.mjs` as `no-restricted-syntax`, covering both plain strings and
template literals, and it runs in the existing CI gate.

## Copy

Sentence case. "You"/"we". No decorative emoji. (The `✓` / `☑` glyphs in
`SignerFiller.tsx` are functional checkbox rendering, not decoration.)
