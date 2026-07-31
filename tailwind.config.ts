import type { Config } from "tailwindcss";

// Tailwind v4 is CSS-first (see src/app/globals.css `@theme inline` block),
// so this file is not loaded by the PostCSS plugin by default. It's kept
// for editor tooling / IntelliSense and as a documented content scan config
// in case a future task needs to reference it explicitly via `@config`.
const config: Config = {
  content: [
    "./src/**/*.{js,ts,jsx,tsx,mdx}",
  ],
};

export default config;
