import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Standalone output for the production Docker image (see Dockerfile).
  // NOTE: standalone does NOT auto-include `public/` — the Dockerfile must
  // separately `COPY --from=builder /app/public ./public`, or the pdf.js
  // worker (public/pdf.worker.min.mjs) will be missing at runtime and the
  // PDF viewer will silently fail.
  output: 'standalone',

  experimental: {
    // Server Actions CSRF: Next compares the browser Origin against the
    // forwarded host. If a reverse proxy rewrites Host to the backend, the app
    // sees an internal x-forwarded-host while the browser Origin is the public
    // domain — they mismatch and EVERY form submit (login, sign-out, send,
    // sign) aborts with "Invalid Server Actions request". Whitelisting the
    // public origin makes the domain valid regardless.
    //
    // The nginx vhost on the deploy host forwards $http_host (NOT $host, which
    // drops the port), so the forwarded host already matches in the normal
    // case — this list is the belt-and-braces for proxies that rewrite Host.
    serverActions: {
      allowedOrigins: ['sign.bevorasg.com'],
    },
  },
};

export default nextConfig;
