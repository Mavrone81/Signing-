// @vitest-environment node
//
// HTTP-LEVEL test, deliberately NOT a handler-level one: the unit test
// (test/unit/notifications-reconcile-route.test.ts) imports POST and calls
// it directly, which can never see a bug in the layer ABOVE the handler —
// and that is exactly where one was found: src/middleware.ts's allow-list
// bounced this route to /login before the handler ever ran. A handler test
// stayed green while the real app returned 302 to every caller, including a
// cron with the correct secret. This test starts the REAL built app (a real
// `next start`, real middleware, real routing) and sends it the request an
// external scheduler would actually send.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const PORT = 3101
const BASE = `http://127.0.0.1:${PORT}`
const SECRET = 'http-level-test-secret-0123456789'

let server: ChildProcess
let serverOutput = ''
let bakedSha: string

async function waitForServer(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/api/health`)
      if (res.ok) return
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 300))
  }
  throw new Error(`server did not become ready within ${timeoutMs}ms. Output:\n${serverOutput}`)
}

beforeAll(async () => {
  const repoRoot = path.resolve(__dirname, '../..')
  // Inherits the SAME DATABASE_URL the rest of the suite already has (set
  // by test/setup-env.ts locally, or by CI's own env block) rather than a
  // hardcoded port — a hardcoded port is this worktree's own disposable
  // container and would point at a database that doesn't exist in CI.
  const env = {
    ...process.env,
    AUTH_SECRET: 'http-level-test-auth-secret-not-real-0000',
    DATA_KEY: '0'.repeat(64),
  }

  // Build via `pnpm build`, not `next build` directly — this triggers the
  // SAME `prebuild` hook (scripts/generate-git-sha.mjs) the real pipeline
  // uses, which writes src/generated/git-sha.ts. No GIT_SHA is set in `env`
  // above, so the generator falls back to `git rev-parse HEAD` itself —
  // exercising the real local/CI path, not a value this test hands it.
  //
  // Building FRESH, right here, from whatever is actually in the working
  // tree RIGHT NOW, is also what makes the reachability tests below mean
  // anything: this test exists to catch a bug in the layer ABOVE the route
  // handler (middleware) by serving a REAL build, and a `.next/` left over
  // from an earlier build or commit is AMBIENT STATE, not evidence about
  // this one. "A build exists" is absence-of-error; building it ourselves
  // is the actual assertion.
  execFileSync('pnpm', ['build'], { cwd: repoRoot, env, stdio: 'inherit' })

  // Read the generated stamp STRAIGHT FROM DISK — not over HTTP — as its
  // own, independent check: this proves the GENERATOR resolved the right
  // commit, decoupled entirely from whether the HTTP auth-gating (tested
  // below) works. A regex match keeps this test from depending on the
  // generated file's exact TS syntax, only its one exported value.
  const generated = readFileSync(path.join(repoRoot, 'src/generated/git-sha.ts'), 'utf8')
  const match = generated.match(/GIT_SHA = "([0-9a-f]{40})"/)
  if (!match) throw new Error(`Could not parse a sha out of src/generated/git-sha.ts:\n${generated}`)
  bakedSha = match[1]

  server = spawn('npx', ['next', 'start', '-p', String(PORT)], {
    cwd: repoRoot,
    env: { ...env, CRON_SECRET: SECRET, NODE_ENV: 'production' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  server.stdout?.on('data', (d) => (serverOutput += d.toString()))
  server.stderr?.on('data', (d) => (serverOutput += d.toString()))
  await waitForServer(60_000)
}, 180_000)

afterAll(() => {
  server?.kill('SIGTERM')
})

describe('the reconcile route is actually reachable through the real middleware', () => {
  it('a correctly-authenticated, SESSION-LESS POST gets a real response, not a redirect to /login', async () => {
    const res = await fetch(`${BASE}/api/internal/notifications/reconcile`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'x-cron-secret': SECRET },
    })
    // Specifically NOT 302 — that is the bug this test exists to catch.
    expect(res.status).not.toBe(302)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toHaveProperty('created')
  })

  // Both directions, over a small table — a middleware that let EVERYTHING
  // through would make the reconcile assertion above pass for the wrong
  // reason: one direction alone has the same "can only pass" shape as a
  // guard that never fires. These two known-private paths prove the
  // middleware is still actually gating, not disabled.
  it.each([
    ['/documents', 'GET'],
    ['/settings/signing', 'GET'],
  ] as const)('control: known SESSION-GATED path %s still redirects to /login with no session', async (pathname, method) => {
    const res = await fetch(`${BASE}${pathname}`, { method, redirect: 'manual' })
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toContain('/login')
  })

  // And a known-already-public path, to rule out the test environment
  // itself silently exempting everything (the inverse failure mode).
  it('control: a known PUBLIC path (/api/health) is reachable with no session, as it already was before this change', async () => {
    const res = await fetch(`${BASE}/api/health`, { method: 'GET', redirect: 'manual' })
    expect(res.status).toBe(200)
    const body = await res.json()
    // Unauthenticated response stays EXACTLY what it was — no sha field,
    // because this repo is public: an unauthenticated sha endpoint would
    // let anyone permanently check whether a merged fix has actually been
    // deployed yet.
    expect(body).toEqual({ status: 'ok' })
  })

  it('control: a wrong secret is rejected with 401, not let through', async () => {
    const res = await fetch(`${BASE}/api/internal/notifications/reconcile`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'x-cron-secret': 'wrong' },
    })
    expect(res.status).toBe(401)
  })
})

describe('provenance: the server serving this test IS the commit under test', () => {
  it('the generated stamp matches the actual git HEAD this test built from (checked on disk, no HTTP involved)', () => {
    const gitHead = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: path.resolve(__dirname, '../..'),
    })
      .toString()
      .trim()
    expect(bakedSha).toBe(gitHead)
  })

  it('an AUTHENTICATED /api/health call reports the SAME sha the build actually stamped', async () => {
    const res = await fetch(`${BASE}/api/health`, {
      method: 'GET',
      headers: { 'x-cron-secret': SECRET },
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    // "A build exists" is absence-of-error; THIS is the actual assertion —
    // that the build being SERVED is the one this test built and verified
    // on disk above, not some other artifact. If this fails, the fix is to
    // rebuild (or find out why the running server is stale/different) —
    // NEVER to relax or remove this assertion: that would silently reopen
    // exactly the "serving a confidently wrong answer about the wrong
    // commit" bug this whole file exists to catch.
    expect(
      body.sha,
      `Server reported sha "${body.sha}" but this test built and started ` +
        `commit "${bakedSha}". The server is serving a DIFFERENT commit ` +
        `than the one under test. Rebuild — do not adjust this assertion.`,
    ).toBe(bakedSha)
  })
})
