import { z } from 'zod'
const schema = z.object({
  NODE_ENV: z.string().default('development'),
  DATABASE_URL: z.string().min(1),
  AUTH_SECRET: z.string().min(16),
  // Canonical external URL of the app (used by Auth.js and to display the exact
  // OAuth redirect URIs on the Settings → Authentication page). Optional here;
  // Auth.js also reads it directly from process.env. SSO requires this to be an
  // https:// URL with a real hostname.
  AUTH_URL: z.string().url().optional(),
  DATA_KEY: z.string().regex(/^[0-9a-fA-F]{64}$/, 'DATA_KEY must be 64 hex chars'),
  STORAGE_DIR: z.string().default('.uploads'),
  MAX_UPLOAD_MB: z.coerce.number().default(25),
  SEED_ADMIN_EMAIL: z.string().email().default('admin@bevorasg.com'),
  SEED_ADMIN_PASSWORD: z.string().min(8).optional(),
  // Default-OFF on purpose: today's live deployment has zero signing
  // certificates for either organization, so an unconditional fail-closed
  // would stop every document completion at the next user action. Only
  // flip this on after every org's admin has generated/uploaded its own
  // certificate in Settings -> Signing. See src/lib/signing-config.ts.
  // (Not `z.coerce.boolean()`: that treats the STRING "false" as truthy —
  // only the literal string "true" turns this on.)
  SIGNING_FAIL_CLOSED: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
  // Sign #11: shared secret the reconciliation-trigger route requires
  // (`X-Cron-Secret` header) so only the operator's own scheduler can fire
  // it, not anyone who finds the URL. Optional here so the app boots without
  // it; the route itself refuses every request (503) until it is set — see
  // src/app/api/internal/notifications/reconcile/route.ts.
  CRON_SECRET: z.string().min(16).optional(),
})
export const env = schema.parse(process.env)
export type Env = z.infer<typeof schema>
