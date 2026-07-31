import { defineConfig, devices } from '@playwright/test'
import path from 'node:path'
import os from 'node:os'

// End-to-end config for the real sign flow (Task 13): login -> upload ->
// place fields -> finalize -> download signed. Runs a real Chromium against
// the actual built+started Next.js app (not a mock), backed by a real
// Postgres.
//
// DB target: reuses the local dev Postgres container (`ds-dev-pg`,
// 127.0.0.1:5433, db `digital_signing`) that's already migrated for
// dev/integration tests, unless DATABASE_URL is already set (e.g. by CI's
// own postgres service). `globalSetup` applies migrations (idempotent) and
// seeds a DEDICATED e2e-only admin user (distinct email from the real dev
// seed admin); `globalTeardown` deletes that user's documents (Fields +
// AuditEvents cascade) and the user row afterward, so a local run never
// leaves e2e data behind in the shared dev DB.
const PORT = 3100
const BASE_URL = `http://127.0.0.1:${PORT}`

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgresql://postgres:devpass@127.0.0.1:5433/digital_signing'

// Set once, here, in the main Playwright process (which loads this config
// before spawning globalSetup / test workers / the webServer child process),
// so every one of those inherits the same values without re-deriving them.
process.env.DATABASE_URL = DATABASE_URL
process.env.AUTH_SECRET ??= 'e2e-test-auth-secret-not-a-real-secret-value'
process.env.DATA_KEY ??= '22'.repeat(32)
process.env.AUTH_TRUST_HOST ??= 'true'
process.env.AUTH_URL ??= BASE_URL
process.env.SEED_ADMIN_EMAIL ??= 'e2e-admin@example.test'
process.env.SEED_ADMIN_PASSWORD ??= 'e2e-only-password-not-real'
process.env.STORAGE_DIR ??= path.join(os.tmpdir(), `digital-signing-e2e-storage-${Date.now()}`)

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: !!process.env.CI,
  reporter: [['list'], ['html', { open: 'never' }]],
  globalSetup: './e2e/global-setup.ts',
  globalTeardown: './e2e/global-teardown.ts',
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    // `pnpm build` runs the prebuild pdf.js-worker copy hook, then `pnpm
    // start` (`next start`) serves the production build on PORT.
    command: 'pnpm build && pnpm start',
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      DATABASE_URL,
      AUTH_SECRET: process.env.AUTH_SECRET!,
      DATA_KEY: process.env.DATA_KEY!,
      AUTH_TRUST_HOST: process.env.AUTH_TRUST_HOST!,
      AUTH_URL: process.env.AUTH_URL!,
      SEED_ADMIN_EMAIL: process.env.SEED_ADMIN_EMAIL!,
      SEED_ADMIN_PASSWORD: process.env.SEED_ADMIN_PASSWORD!,
      STORAGE_DIR: process.env.STORAGE_DIR!,
      PORT: String(PORT),
      NODE_ENV: 'production',
    },
  },
})
