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
import { spawn, type ChildProcess } from 'node:child_process'
import path from 'node:path'

const PORT = 3101
const BASE = `http://127.0.0.1:${PORT}`
const SECRET = 'http-level-test-secret-0123456789'

let server: ChildProcess
let serverOutput = ''

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
  server = spawn('npx', ['next', 'start', '-p', String(PORT)], {
    cwd: repoRoot,
    env: {
      ...process.env,
      DATABASE_URL: 'postgresql://postgres:devpass@127.0.0.1:15593/digital_signing',
      AUTH_SECRET: 'http-level-test-auth-secret-not-real-0000',
      DATA_KEY: '0'.repeat(64),
      CRON_SECRET: SECRET,
      NODE_ENV: 'production',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  server.stdout?.on('data', (d) => (serverOutput += d.toString()))
  server.stderr?.on('data', (d) => (serverOutput += d.toString()))
  await waitForServer(60_000)
}, 70_000)

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
