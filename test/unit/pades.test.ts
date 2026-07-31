// @vitest-environment node
//
// PAdES/PKI signing — pure crypto + PDF pipeline (no DB). Runs under plain
// `node` (real crypto + pdf-lib), same as flatten/certificate tests.
import { describe, it, expect } from 'vitest'
import forge from 'node-forge'
import { PDFDocument } from 'pdf-lib'
import { generateSelfSignedP12, parseP12Metadata } from '../../src/lib/pki'
import { padesSign, verifyPades } from '../../src/server/pdf/pades'

async function samplePdf(): Promise<Uint8Array> {
  const d = await PDFDocument.create()
  d.addPage([600, 800]).drawText('Contract body')
  return d.save()
}

describe('generateSelfSignedP12', () => {
  it('produces a valid RSA-2048 self-signed X.509 in a parseable P12', () => {
    const { p12, metadata } = generateSelfSignedP12({
      commonName: 'Bevora Sign Platform',
      passphrase: 'pw123',
      years: 3,
    })
    expect(metadata.subject).toContain('CN=Bevora Sign Platform')
    // self-signed ⇒ issuer == subject
    expect(metadata.issuer).toBe(metadata.subject)
    expect(metadata.fingerprint).toMatch(/^[0-9a-f]{64}$/)
    // ~3 years validity
    const spanYears =
      (metadata.notAfter.getTime() - metadata.notBefore.getTime()) / (365.25 * 24 * 3600 * 1000)
    expect(spanYears).toBeGreaterThan(2.9)
    expect(spanYears).toBeLessThan(3.1)

    // The P12 parses back to the same cert, and its key is RSA-2048.
    const p12Asn1 = forge.asn1.fromDer(forge.util.createBuffer(p12.toString('binary')))
    const parsed = forge.pkcs12.pkcs12FromAsn1(p12Asn1, false, 'pw123')
    const keyBag = parsed.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })[
      forge.pki.oids.pkcs8ShroudedKeyBag
    ]![0]
    expect((keyBag.key as forge.pki.rsa.PrivateKey).n.bitLength()).toBe(2048)
  })

  it('round-trips metadata via parseP12Metadata and rejects a wrong passphrase', () => {
    const { p12, metadata } = generateSelfSignedP12({ commonName: 'X', passphrase: 'right' })
    expect(parseP12Metadata(p12, 'right').fingerprint).toBe(metadata.fingerprint)
    expect(() => parseP12Metadata(p12, 'wrong')).toThrow()
  })
})

describe('padesSign + verifyPades', () => {
  it('produces an ETSI.CAdES.detached signature whose ByteRange covers the whole file and whose CMS verifies', async () => {
    const { p12 } = generateSelfSignedP12({ commonName: 'Sealer', passphrase: 'pw' })
    const signed = await padesSign(await samplePdf(), { p12, passphrase: 'pw' })

    // Subfilter present.
    expect(Buffer.from(signed).includes('ETSI.CAdES.detached')).toBe(true)

    const v = verifyPades(signed)
    expect(v.signed).toBe(true)
    expect(v.byteRangeCoversFile).toBe(true)
    expect(v.valid).toBe(true)
    expect(v.signerSubject).toContain('CN=Sealer')
    expect(v.signerFingerprint).toMatch(/^[0-9a-f]{64}$/)
  })

  it('fails verification when the signed bytes are tampered with', async () => {
    const { p12 } = generateSelfSignedP12({ commonName: 'Sealer', passphrase: 'pw' })
    const signed = await padesSign(await samplePdf(), { p12, passphrase: 'pw' })

    // Flip a byte inside the covered content (well before the signature gap).
    const tampered = Buffer.from(signed)
    tampered[80] = tampered[80] ^ 0xff
    const v = verifyPades(tampered)
    expect(v.valid).toBe(false)
  })

  it('reports an unsigned PDF as not signed', async () => {
    const v = verifyPades(await samplePdf())
    expect(v.signed).toBe(false)
    expect(v.valid).toBe(false)
  })
})
