import { describe, it, expect } from 'vitest'
import { createHmac } from 'crypto'
import {
  signBody,
  generateWebhookSecret,
  isBlockedWebhookUrl,
  isWebhookEvent,
  WEBHOOK_EVENTS,
} from '../../src/lib/webhooks'

describe('webhooks — HMAC signing', () => {
  it('signBody is HMAC-SHA256(secret, body) hex', () => {
    const secret = 'whsec_test'
    const body = JSON.stringify({ event: 'document.sent', data: { x: 1 }, timestamp: 't' })
    const expected = createHmac('sha256', secret).update(body, 'utf8').digest('hex')
    expect(signBody(secret, body)).toBe(expected)
    expect(signBody(secret, body)).toHaveLength(64)
  })

  it('signature changes if the body or secret changes (tamper-evident)', () => {
    const body = '{"a":1}'
    expect(signBody('s1', body)).not.toBe(signBody('s2', body))
    expect(signBody('s1', body)).not.toBe(signBody('s1', '{"a":2}'))
  })

  it('generateWebhookSecret is a unique whsec_ secret', () => {
    const a = generateWebhookSecret()
    const b = generateWebhookSecret()
    expect(a.startsWith('whsec_')).toBe(true)
    expect(a).not.toBe(b)
  })
})

describe('webhooks — SSRF guard', () => {
  it('allows a public https URL', () => {
    expect(isBlockedWebhookUrl('https://example.com/hook')).toBe(false)
    expect(isBlockedWebhookUrl('http://api.acme.io/webhooks')).toBe(false)
  })

  it('blocks internal / loopback / link-local / private targets', () => {
    for (const u of [
      'http://localhost/hook',
      'http://localhost:3000/x',
      'http://127.0.0.1/x',
      'http://[::1]/x',
      'http://169.254.169.254/latest/meta-data', // cloud metadata
      'http://10.10.10.11/x',
      'http://192.168.1.10/x',
      'http://172.16.0.1/x',
      'http://box.internal/x',
      'http://printer.local/x',
      'http://0.0.0.0/x',
    ]) {
      expect(isBlockedWebhookUrl(u), u).toBe(true)
    }
  })

  it('blocks non-http(s) schemes and garbage', () => {
    expect(isBlockedWebhookUrl('ftp://example.com')).toBe(true)
    expect(isBlockedWebhookUrl('file:///etc/passwd')).toBe(true)
    expect(isBlockedWebhookUrl('not a url')).toBe(true)
  })
})

describe('webhooks — event catalog', () => {
  it('isWebhookEvent recognizes known events only', () => {
    for (const e of WEBHOOK_EVENTS) expect(isWebhookEvent(e)).toBe(true)
    expect(isWebhookEvent('document.deleted')).toBe(false)
    expect(isWebhookEvent(123)).toBe(false)
  })
})
