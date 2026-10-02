// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest'

const reconcile = vi.hoisted(() => vi.fn(async () => ({ created: 0 })))
vi.mock('@/server/notifications/cert-expiry', () => ({
  reconcileCertExpiryNotifications: reconcile,
}))

const envMock = vi.hoisted(() => ({ env: { CRON_SECRET: undefined as string | undefined } }))
vi.mock('@/env', () => envMock)

beforeEach(() => {
  reconcile.mockClear()
  envMock.env.CRON_SECRET = undefined
})

function req(headers: Record<string, string> = {}): Request {
  return new Request('http://localhost/api/internal/notifications/reconcile', {
    method: 'POST',
    headers,
  })
}

describe('POST /api/internal/notifications/reconcile', () => {
  it('503s, and never calls reconcile, when CRON_SECRET is not configured — loud, not a silent no-op', async () => {
    const { POST } = await import('../../src/app/api/internal/notifications/reconcile/route')
    const res = await POST(req({ 'x-cron-secret': 'anything' }) as never)
    expect(res.status).toBe(503)
    expect(reconcile).not.toHaveBeenCalled()
  })

  it('401s on a wrong secret, and never calls reconcile', async () => {
    envMock.env.CRON_SECRET = 'the-real-secret-1234567890'
    const { POST } = await import('../../src/app/api/internal/notifications/reconcile/route')
    const res = await POST(req({ 'x-cron-secret': 'wrong' }) as never)
    expect(res.status).toBe(401)
    expect(reconcile).not.toHaveBeenCalled()
  })

  it('401s when the header is missing entirely', async () => {
    envMock.env.CRON_SECRET = 'the-real-secret-1234567890'
    const { POST } = await import('../../src/app/api/internal/notifications/reconcile/route')
    const res = await POST(req() as never)
    expect(res.status).toBe(401)
    expect(reconcile).not.toHaveBeenCalled()
  })

  it('runs reconciliation and returns 200 on the correct secret', async () => {
    envMock.env.CRON_SECRET = 'the-real-secret-1234567890'
    const { POST } = await import('../../src/app/api/internal/notifications/reconcile/route')
    const res = await POST(req({ 'x-cron-secret': 'the-real-secret-1234567890' }) as never)
    expect(res.status).toBe(200)
    expect(reconcile).toHaveBeenCalledTimes(1)
    expect(await res.json()).toEqual({ created: 0 })
  })
})
