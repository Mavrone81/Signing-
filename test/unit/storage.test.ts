import { describe, it, expect, beforeAll } from 'vitest'

// See test/unit/crypto.test.ts for why this uses beforeAll() + dynamic
// import() instead of top-level `process.env.X = ...` followed by a static
// import: static imports are hoisted above this file's own statements, so
// src/env.ts would otherwise parse before STORAGE_DIR is overridden and
// silently fall back to the real project `.uploads/` dir instead of an
// isolated /tmp dir.
describe('storage', () => {
  beforeAll(() => {
    process.env.DATA_KEY ||= '0'.repeat(64)
    process.env.STORAGE_DIR = '/tmp/ds-test-' + Date.now()
  })

  it('encrypts at rest + reads back', async () => {
    const { putObject, getObject } = await import('../../src/lib/storage')
    await putObject('doc1/original.pdf', Buffer.from('PDFDATA'))
    expect((await getObject('doc1/original.pdf')).toString()).toBe('PDFDATA')
  })

  it('rejects path traversal', async () => {
    const { putObject } = await import('../../src/lib/storage')
    await expect(putObject('../escape', Buffer.from('x'))).rejects.toThrow()
  })
})
