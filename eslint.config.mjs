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
];

export default eslintConfig;
