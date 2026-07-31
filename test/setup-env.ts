// Vitest setup file (see vitest.config.ts `test.setupFiles`).
//
// src/env.ts fails closed: it throws at import time if required env vars
// (DATABASE_URL, AUTH_SECRET, DATA_KEY) are missing. Vitest does NOT load
// .env files automatically, so importing anything that pulls in `@/env`
// (directly or transitively, e.g. src/lib/storage.ts, src/lib/crypto.ts)
// would otherwise fail unless a human manually sourced .env first.
//
// This file runs once before each test file is collected/imported, so it
// sets fixed, obviously-fake, test-only values before any test module (and
// therefore src/env.ts) is evaluated. These are NOT read from or related to
// the real .env — do not put real secrets here.
//
// `||=` is used so an individual test file (e.g. env.test.ts, crypto.test.ts,
// storage.test.ts) can still delete/override a var for its own scenario.
import os from 'node:os'
import path from 'node:path'

// NODE_ENV is already set to "test" by Vitest itself, and its type is
// read-only in Next.js's ambient types, so it is intentionally not touched
// here. src/env.ts also defaults it to "development" if unset.
//
// There is no separate test Postgres instance in this environment — only
// the local dev DB container (`ds-dev-pg`, 127.0.0.1:5433, db
// `digital_signing`, seeded/migrated per Task 2). Integration tests
// (test/integration/**) run against it directly, per Task 8's brief. These
// are dev-only, non-secret default credentials (matching .env.example),
// not production values.
process.env.DATABASE_URL ||=
  'postgresql://postgres:devpass@127.0.0.1:5433/digital_signing'
process.env.AUTH_SECRET ||= 'test-only-auth-secret-do-not-use-in-prod'
process.env.DATA_KEY ||= '0'.repeat(64)
// Never default to the repo's real .uploads dir in tests.
process.env.STORAGE_DIR ||= path.join(os.tmpdir(), 'digital-signing-test-uploads')
process.env.MAX_UPLOAD_MB ||= '25'
process.env.SEED_ADMIN_EMAIL ||= 'test-admin@example.com'
process.env.SEED_ADMIN_PASSWORD ||= 'test-only-password'
