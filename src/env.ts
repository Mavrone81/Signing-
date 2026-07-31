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
})
export const env = schema.parse(process.env)
export type Env = z.infer<typeof schema>
