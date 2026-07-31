// @vitest-environment node
import { describe, it, expect } from 'vitest'
process.env.DATA_KEY ||= '0'.repeat(64)
process.env.STORAGE_DIR = '/tmp/ds-brand-' + Date.now()

import {
  resolveBrand,
  normalizeHex,
  validateLogo,
  logoKeyFor,
  logoMimeFromKey,
  loadLogoDataUri,
  DEFAULT_BRAND_COLOR,
  MAX_LOGO_BYTES,
} from '../../src/lib/branding'
import { putObject } from '../../src/lib/storage'

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01])
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10])
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>')

describe('normalizeHex', () => {
  it('accepts #rrggbb and #rgb, normalizes case + expands short form', () => {
    expect(normalizeHex('#2DA66D')).toBe('#2da66d')
    expect(normalizeHex('2da66d')).toBe('#2da66d')
    expect(normalizeHex('#abc')).toBe('#aabbcc')
  })
  it('rejects garbage → null', () => {
    expect(normalizeHex('red')).toBeNull()
    expect(normalizeHex('#12')).toBeNull()
    expect(normalizeHex('  ')).toBeNull()
    expect(normalizeHex(null)).toBeNull()
    expect(normalizeHex('#2da66d; background:url(x)')).toBeNull()
  })
})

describe('resolveBrand', () => {
  it('uncustomized org → customized:false, falls back to org name + default green', () => {
    const b = resolveBrand({ name: 'Acme', brandName: null, brandColor: null, logoKey: null })
    expect(b.customized).toBe(false)
    expect(b.name).toBe('Acme')
    expect(b.color).toBe(DEFAULT_BRAND_COLOR)
    expect(b.hasLogo).toBe(false)
  })
  it('any set field marks it customized; brandName overrides org name', () => {
    expect(resolveBrand({ name: 'Acme', brandName: 'Acme Legal', brandColor: null, logoKey: null }))
      .toMatchObject({ customized: true, name: 'Acme Legal', color: DEFAULT_BRAND_COLOR })
    expect(resolveBrand({ name: 'Acme', brandName: null, brandColor: '#123456', logoKey: null }))
      .toMatchObject({ customized: true, name: 'Acme', color: '#123456' })
    expect(resolveBrand({ name: 'Acme', brandName: null, brandColor: null, logoKey: 'branding/o/logo.png' }))
      .toMatchObject({ customized: true, hasLogo: true, logoKey: 'branding/o/logo.png' })
  })
  it('invalid stored colour degrades to the default green', () => {
    const b = resolveBrand({ name: 'Acme', brandName: 'X', brandColor: 'not-a-color', logoKey: null })
    expect(b.color).toBe(DEFAULT_BRAND_COLOR)
  })
})

describe('validateLogo', () => {
  it('accepts PNG / JPEG / SVG by magic bytes', () => {
    expect(validateLogo(PNG)).toMatchObject({ ok: true, ext: 'png' })
    expect(validateLogo(JPG)).toMatchObject({ ok: true, ext: 'jpg' })
    expect(validateLogo(SVG)).toMatchObject({ ok: true, ext: 'svg' })
  })
  it('rejects a non-image (e.g. a PDF) by content, not by name', () => {
    expect(validateLogo(Buffer.from('%PDF-1.7 ...'))).toMatchObject({ ok: false, reason: 'type' })
  })
  it('rejects empty + oversize', () => {
    expect(validateLogo(Buffer.alloc(0))).toMatchObject({ ok: false, reason: 'empty' })
    const big = Buffer.concat([PNG, Buffer.alloc(MAX_LOGO_BYTES + 1)])
    expect(validateLogo(big)).toMatchObject({ ok: false, reason: 'size' })
  })
})

describe('logo key + mime', () => {
  it('keys per org with the type extension, recovers the mime', () => {
    expect(logoKeyFor('org123', 'png')).toBe('branding/org123/logo.png')
    expect(logoMimeFromKey('branding/o/logo.png')).toBe('image/png')
    expect(logoMimeFromKey('branding/o/logo.jpg')).toBe('image/jpeg')
    expect(logoMimeFromKey('branding/o/logo.svg')).toBe('image/svg+xml')
  })
})

describe('loadLogoDataUri', () => {
  it('null key → null; a stored blob round-trips to a data: URI', async () => {
    expect(await loadLogoDataUri(null)).toBeNull()
    const key = logoKeyFor('org-load', 'png')
    await putObject(key, PNG)
    const uri = await loadLogoDataUri(key)
    expect(uri).toBe(`data:image/png;base64,${PNG.toString('base64')}`)
  })
  it('missing blob → null (best-effort, never throws)', async () => {
    expect(await loadLogoDataUri('branding/nope/logo.png')).toBeNull()
  })
})
