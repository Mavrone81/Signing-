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
export function generateSelfSignedP12(opts: {
  commonName: string
  passphrase: string
  years?: number
}): { p12: Buffer; metadata: CertMetadata } {
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
  cert.validity.notBefore = new Date()
  cert.validity.notAfter = new Date()
  cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + years)

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
