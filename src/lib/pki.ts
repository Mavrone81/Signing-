// Server-only PKI helpers (node-forge): generate a self-signed platform signing
// certificate, wrap key+cert into a PKCS#12, and extract non-secret certificate
// metadata from a PKCS#12. NEVER import into a client bundle — it handles
// private-key material.
import { generateKeyPairSync } from 'crypto'
import forge from 'node-forge'

export type CertMetadata = {
  subject: string
  issuer: string
  serial: string
  notBefore: Date
  notAfter: Date
  // SHA-256 (hex) of the signer certificate DER — a stable public fingerprint.
  fingerprint: string
}

// Single source of truth for "is this certificate expired", shared by the
// upload-time rejection (settings/signing/actions.ts), the sealing-time
// refusal (signing-config.ts), and Sign #11's expiry-day notification — all
// three must use the exact same boundary (`<=`, not `<`: a certificate is
// not valid AT its own expiry instant). `now` is an optional injectable
// override (defaults to the real clock) so a test can pin it to an exact
// instant without a global `Date` mock — see Sign #11's threshold tests for
// why: this feature IS its boundaries, and a global mock can't express "one
// second either side" as cleanly as passing a `Date`.
export function isCertificateExpired(notAfter: Date, now: Date = new Date()): boolean {
  return notAfter.getTime() <= now.getTime()
}

// Single source of truth for the SOFT countdown (days remaining, can be
// negative once expired), shared by the settings-page indicator
// (signing-config.ts) and Sign #11's threshold logic — reused, not
// recomputed independently, so the two can't drift into disagreement.
// Math.ceil reaches exactly 0 at the same instant isCertificateExpired turns
// true (ceil(x) <= 0  <=>  x <= 0 for the same `now`), so the hard and soft
// checks agree at the boundary by construction, not by coincidence.
export function daysUntilExpiry(notAfter: Date, now: Date = new Date()): number {
  return Math.ceil((notAfter.getTime() - now.getTime()) / 86_400_000)
}

// F1c (found reviewing F1b, by construction): the mirror image of
// expiry — notBefore was never checked anywhere, so a not-yet-valid
// certificate (e.g. an admin-supplied P12 issued for future use) uploaded
// cleanly and became active. Shares the same two call sites as
// isCertificateExpired above.
export function isCertificateNotYetValid(notBefore: Date): boolean {
  return notBefore.getTime() > Date.now()
}

// Build a readable RFC-4514-ish DN string ("CN=…, O=…") from a forge subject/
// issuer attribute list.
function dnToString(attrs: forge.pki.CertificateField[]): string {
  return attrs
    .map((a) => {
      const key = a.shortName || a.name || a.type || '?'
      return `${key}=${a.value ?? ''}`
    })
    .join(', ')
}

// SHA-256 hex fingerprint of a forge certificate's DER encoding.
export function certFingerprint(cert: forge.pki.Certificate): string {
  const der = forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes()
  return forge.md.sha256.create().update(der).digest().toHex()
}

export function certMetadata(cert: forge.pki.Certificate): CertMetadata {
  return {
    subject: dnToString(cert.subject.attributes),
    issuer: dnToString(cert.issuer.attributes),
    serial: cert.serialNumber,
    notBefore: cert.validity.notBefore,
    notAfter: cert.validity.notAfter,
    fingerprint: certFingerprint(cert),
  }
}

/**
 * Generates an RSA-2048 key + self-signed X.509 certificate (CN = the given
 * platform/brand name, ~`years` validity) and wraps them into a passphrase-
 * protected PKCS#12. The RSA key is generated with Node's CSPRNG
 * (crypto.generateKeyPairSync) — secure server-side randomness — then imported
 * into forge for certificate issuance.
 *
 * Returns the DER PKCS#12 bytes plus the parsed non-secret certificate metadata.
 */
type GenerateSelfSignedP12Opts = {
  commonName: string
  passphrase: string
} & (
  | { years?: number; validity?: undefined }
  // Test-only escape hatch: override the issued validity window directly
  // instead of deriving it from `years`. Lets tests build a REAL, otherwise
  // normal self-signed P12 (same code path as production) whose certificate
  // happens to already be expired or not-yet-valid — needed to exercise the
  // upload-time and sealing-time guards with a realistic fixture, not a
  // hand-rolled one. Production call sites never pass this. Mutually
  // exclusive with `years` AT THE TYPE LEVEL (not just "ignored if both are
  // given"): passing both would silently ignore one of them, which is
  // exactly the shape of bug this release has hit more than once today.
  | { years?: undefined; validity: { notBefore: Date; notAfter: Date } }
)

export function generateSelfSignedP12(
  opts: GenerateSelfSignedP12Opts,
): { p12: Buffer; metadata: CertMetadata } {
  const years = opts.years && opts.years > 0 ? opts.years : 3
  const cn = opts.commonName.trim() || 'Bevora Sign'

  // Secure randomness: Node CSPRNG for the RSA key, imported into forge.
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  })
  const forgePriv = forge.pki.privateKeyFromPem(privateKey)
  const forgePub = forge.pki.publicKeyFromPem(publicKey)

  const cert = forge.pki.createCertificate()
  cert.publicKey = forgePub
  // A random positive serial (leading 0x00 keeps it non-negative in DER).
  cert.serialNumber = '00' + forge.util.bytesToHex(forge.random.getBytesSync(16))
  if (opts.validity) {
    cert.validity.notBefore = opts.validity.notBefore
    cert.validity.notAfter = opts.validity.notAfter
  } else {
    cert.validity.notBefore = new Date()
    cert.validity.notAfter = new Date()
    cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + years)
  }

  const attrs = [
    { name: 'commonName', value: cn },
    { name: 'organizationName', value: 'Bevora Sign' },
  ]
  cert.setSubject(attrs)
  cert.setIssuer(attrs) // self-signed: issuer == subject
  cert.setExtensions([
    { name: 'basicConstraints', cA: false },
    { name: 'keyUsage', digitalSignature: true, nonRepudiation: true },
    { name: 'extKeyUsage', emailProtection: true, clientAuth: true },
  ])
  cert.sign(forgePriv, forge.md.sha256.create())

  const p12Asn1 = forge.pkcs12.toPkcs12Asn1(forgePriv, [cert], opts.passphrase, {
    algorithm: '3des',
  })
  const p12Der = forge.asn1.toDer(p12Asn1).getBytes()

  return { p12: Buffer.from(p12Der, 'binary'), metadata: certMetadata(cert) }
}

/**
 * Parses a PKCS#12 with the given passphrase, locating the certificate that
 * matches the private key, and returns its non-secret metadata. Throws if the
 * passphrase is wrong or the P12 has no usable key/certificate — used to
 * validate an uploaded P12 before it is stored.
 */
export function parseP12Metadata(p12: Buffer, passphrase: string): CertMetadata {
  const p12Asn1 = forge.asn1.fromDer(forge.util.createBuffer(p12.toString('binary')))
  // Throws on a wrong passphrase / malformed P12.
  const p12Obj = forge.pkcs12.pkcs12FromAsn1(p12Asn1, false, passphrase)

  const certBags = p12Obj.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag] ?? []
  const keyBags =
    p12Obj.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })[
      forge.pki.oids.pkcs8ShroudedKeyBag
    ] ?? []
  const privateKey = keyBags[0]?.key
  if (!privateKey) throw new Error('P12_NO_PRIVATE_KEY')

  // Prefer the certificate whose public key matches the private key (the leaf).
  let leaf: forge.pki.Certificate | undefined
  for (const bag of certBags) {
    const cert = bag.cert
    if (!cert) continue
    const pub = cert.publicKey as forge.pki.rsa.PublicKey
    const priv = privateKey as forge.pki.rsa.PrivateKey
    if (pub.n && priv.n && pub.n.compareTo(priv.n) === 0 && pub.e.compareTo(priv.e) === 0) {
      leaf = cert
      break
    }
  }
  if (!leaf) leaf = certBags[0]?.cert ?? undefined
  if (!leaf) throw new Error('P12_NO_CERTIFICATE')

  return certMetadata(leaf)
}
