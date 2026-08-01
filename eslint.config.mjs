import { dirname } from "path";
import { fileURLToPath } from "url";
import { FlatCompat } from "@eslint/eslintrc";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({
  baseDirectory: __dirname,
});

const eslintConfig = [
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  {
    ignores: [
      "node_modules/**",
      ".next/**",
      "out/**",
      "build/**",
      "next-env.d.ts",
      // Vendored pdf.js worker copied into public/ by scripts/copy-pdf-worker.mjs
      // (prebuild/postinstall hook) — a minified third-party asset, not app
      // code. Without this, eslint chokes on it (no-this-alias errors, etc.)
      // and `pnpm lint` is permanently red, which would break the CI gate.
      "public/pdf.worker.min.mjs",
    ],
  },
  {
    // Brand adherence: keep colour on the Bevora ramp.
    //
    // Ported from the Bevora Design System's `_adherence.oxlintrc.json` rather
    // than wiring that file up directly — it is an oxlint config (this repo
    // lints with eslint), and two of its three rules do not fit here: it bans
    // raw `px` (this codebase deliberately sets `text-[13px]` and friends) and
    // raw hex (legitimately needed for Google/Microsoft's exact brand colours
    // on the SSO buttons, the gold gradient stops in BevoraSignMark, and
    // email-templates.ts, where hex is mandatory because email clients do not
    // support CSS variables).
    //
    // What is left is the rule that actually matters, and the one that would
    // have caught the drift this repo already had: a Tailwind palette colour
    // used instead of a semantic token. Reach for --good/--warn/--danger/
    // --info (and their -tint washes) or the brand/neutral tokens in
    // globals.css. If a token is missing, ADD IT — the settings pages drifted
    // precisely because there was no wash token for an alert background.
    files: ["src/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "Literal[value=/\\b(?:bg|text|border|ring|from|via|to|fill|stroke|divide|outline|decoration|accent|caret|placeholder)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\\d{2,3}\\b/]",
          message:
            "Off-palette Tailwind colour. Use a Bevora token (good/warn/danger/info, their -tint washes, or brand/ink/muted/edge) from src/app/globals.css — and add the token if it is missing.",
        },
        {
          selector:
            "TemplateElement[value.raw=/\\b(?:bg|text|border|ring|from|via|to|fill|stroke|divide|outline|decoration|accent|caret|placeholder)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\\d{2,3}\\b/]",
          message:
            "Off-palette Tailwind colour. Use a Bevora token (good/warn/danger/info, their -tint washes, or brand/ink/muted/edge) from src/app/globals.css — and add the token if it is missing.",
        },
      ],
    },
  },
];

export default eslintConfig;
