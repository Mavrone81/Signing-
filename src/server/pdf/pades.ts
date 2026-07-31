// Server-only PAdES/PKI signing pipeline. Turns the final flattened PDF into a
// PAdES-compliant, tamper-evident PDF: a detached CMS/PKCS#7 signature
// (subfilter ETSI.CAdES.detached) over a whole-file ByteRange, embedded in an
// AcroForm signature field. Optionally embeds an RFC-3161 trusted timestamp
// (PAdES-T) — best-effort: an unreachable/failing TSA never fails the signing.
//
// NEVER import into a client bundle — handles private-key material.
import signpdf from '@signpdf/signpdf'
import { Signer, SUBFILTER_ETSI_CADES_DETACHED } from '@signpdf/utils'
import { plainAddPlaceholder } from '@signpdf/placeholder-plain'
import { PDFDocument } from 'pdf-lib'
import forge from 'node-forge'

// id-aa-timeStampToken — the CMS unsigned attribute that carries an RFC-3161
// timestamp token (PAdES-T).
const OID_TIMESTAMP_TOKEN = '1.2.840.113549.1.9.16.2.14'
// sha-256 AlgorithmIdentifier OID (used in the TSA request's messageImprint).
const OID_SHA256 = '2.16.840.1.101.3.4.2.1'
const OID_MESSAGE_DIGEST = forge.pki.oids.messageDigest // 1.2.840.113549.1.9.4
const OID_SIGNING_TIME = forge.pki.oids.signingTime // 1.2.840.113549.1.9.5

export type SigningMaterial = {
  // The PKCS#12 (key + cert chain) bytes and its passphrase.
  p12: Buffer
  passphrase: string
  // Optional RFC-3161 TSA endpoint (e.g. http://timestamp.digicert.com).
  tsaUrl?: string | null
}

const { asn1, pki, util, md, pkcs7, pkcs12 } = forge

// Find the single universal OCTET STRING at the top level of a SignerInfo — the
// signature value (issuerAndSerial is a SEQUENCE, signedAttrs is context [0], so
// the only direct universal OCTET STRING child is the signature).
function findSignatureOctetString(signerInfo: forge.asn1.Asn1): forge.asn1.Asn1 | null {
  for (const child of signerInfo.value as forge.asn1.Asn1[]) {
    if (child.tagClass === asn1.Class.UNIVERSAL && child.type === asn1.Type.OCTETSTRING) {
      return child
    }
  }
  return null
}

// Build an RFC-3161 TimeStampReq for sha256(messageBytes).
function buildTimeStampReq(messageBytes: string): string {
  const hash = md.sha256.create().update(messageBytes).digest().getBytes()
  const req = asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, [
    // version INTEGER v1
    asn1.create(asn1.Class.UNIVERSAL, asn1.Type.INTEGER, false, String.fromCharCode(1)),
    // messageImprint SEQUENCE { AlgorithmIdentifier, OCTET STRING }
    asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, [
      asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, [
        asn1.create(asn1.Class.UNIVERSAL, asn1.Type.OID, false, asn1.oidToDer(OID_SHA256).getBytes()),
        asn1.create(asn1.Class.UNIVERSAL, asn1.Type.NULL, false, ''),
      ]),
      asn1.create(asn1.Class.UNIVERSAL, asn1.Type.OCTETSTRING, false, hash),
    ]),
    // certReq BOOLEAN TRUE — ask the TSA to include its certificate.
    asn1.create(asn1.Class.UNIVERSAL, asn1.Type.BOOLEAN, false, String.fromCharCode(0xff)),
  ])
  return asn1.toDer(req).getBytes()
}

// Request a timestamp token from a TSA over the given signature bytes. Returns
// the timeStampToken ContentInfo ASN.1, or null on any failure (best-effort).
async function requestTimestampToken(
  tsaUrl: string,
  signatureBytes: string,
): Promise<forge.asn1.Asn1 | null> {
  try {
    const reqDer = buildTimeStampReq(signatureBytes)
    const res = await fetch(tsaUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/timestamp-query' },
      body: Buffer.from(reqDer, 'binary'),
      signal: AbortSignal.timeout(8000),
    })
    if (!res.ok) throw new Error(`TSA HTTP ${res.status}`)
    const respBytes = Buffer.from(await res.arrayBuffer())
    const resp = asn1.fromDer(util.createBuffer(respBytes.toString('binary')))
    // TimeStampResp ::= SEQUENCE { status PKIStatusInfo, timeStampToken OPTIONAL }
    const token = (resp.value as forge.asn1.Asn1[])[1]
    if (!token) throw new Error('TSA response has no timeStampToken')
    return token
  } catch (err) {
    console.error('[pades] TSA timestamp failed, signing without it:', err instanceof Error ? err.message : String(err))
    return null
  }
}

// Inject an RFC-3161 timestamp token into a forge SignedData ASN.1 as the
// SignerInfo's [1] unsignedAttrs (id-aa-timeStampToken). Mutates + returns the
// contentInfo ASN.1.
function injectTimestamp(
  contentInfo: forge.asn1.Asn1,
  timeStampToken: forge.asn1.Asn1,
): forge.asn1.Asn1 {
  const signedData = (contentInfo.value as forge.asn1.Asn1[])[1].value[0] as forge.asn1.Asn1
  // signerInfos is the trailing SET OF SignerInfo.
  const parts = signedData.value as forge.asn1.Asn1[]
  const signerInfos = parts[parts.length - 1]
  const signerInfo = (signerInfos.value as forge.asn1.Asn1[])[0]

  // Attribute ::= SEQUENCE { OID id-aa-timeStampToken, SET { timeStampToken } }
  const attr = asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, [
    asn1.create(asn1.Class.UNIVERSAL, asn1.Type.OID, false, asn1.oidToDer(OID_TIMESTAMP_TOKEN).getBytes()),
    asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SET, true, [timeStampToken]),
  ])
  // unsignedAttrs [1] IMPLICIT SET OF Attribute → context-tag 1, constructed.
  const unsignedAttrs = asn1.create(asn1.Class.CONTEXT_SPECIFIC, 1, true, [attr])
  ;(signerInfo.value as forge.asn1.Asn1[]).push(unsignedAttrs)
  return contentInfo
}

/**
 * A @signpdf Signer that produces a detached PKCS#7 (adbe/ETSI CAdES) signature
 * from a PKCS#12, optionally embedding an RFC-3161 timestamp. Mirrors
 * @signpdf/signer-p12 but adds best-effort TSA support (which the stock signer
 * lacks).
 */
export class PlatformSigner extends Signer {
  private material: SigningMaterial

  constructor(material: SigningMaterial) {
    super()
    this.material = material
  }

  async sign(pdfBuffer: Buffer, signingTime?: Date): Promise<Buffer> {
    if (!Buffer.isBuffer(pdfBuffer)) throw new Error('PDF expected as Buffer.')

    const p12Asn1 = asn1.fromDer(util.createBuffer(this.material.p12.toString('binary')))
    const p12 = pkcs12.pkcs12FromAsn1(p12Asn1, false, this.material.passphrase)

    const certBags = p12.getBags({ bagType: pki.oids.certBag })[pki.oids.certBag] ?? []
    const keyBags =
      p12.getBags({ bagType: pki.oids.pkcs8ShroudedKeyBag })[pki.oids.pkcs8ShroudedKeyBag] ?? []
    const privateKey = keyBags[0]?.key
    if (!privateKey) throw new Error('P12 has no private key.')

    const p7 = pkcs7.createSignedData()
    p7.content = util.createBuffer(pdfBuffer.toString('binary'))

    let certificate: forge.pki.Certificate | undefined
    for (const bag of certBags) {
      const cert = bag.cert
      if (!cert) continue
      p7.addCertificate(cert)
      const pub = cert.publicKey as forge.pki.rsa.PublicKey
      const priv = privateKey as forge.pki.rsa.PrivateKey
      if (pub.n && priv.n && pub.n.compareTo(priv.n) === 0 && pub.e.compareTo(priv.e) === 0) {
        certificate = cert
      }
    }
    if (!certificate) throw new Error('Failed to find a certificate matching the private key.')

    p7.addSigner({
      key: privateKey as forge.pki.rsa.PrivateKey,
      certificate,
      digestAlgorithm: pki.oids.sha256,
      authenticatedAttributes: [
        { type: pki.oids.contentType, value: pki.oids.data },
        { type: OID_SIGNING_TIME, value: (signingTime ?? new Date()) as unknown as string },
        { type: OID_MESSAGE_DIGEST },
      ],
    })
    p7.sign({ detached: true })

    let contentInfo = p7.toAsn1()

    // Best-effort RFC-3161 timestamp (PAdES-T).
    if (this.material.tsaUrl) {
      const sd = (contentInfo.value as forge.asn1.Asn1[])[1].value[0] as forge.asn1.Asn1
      const parts = sd.value as forge.asn1.Asn1[]
      const signerInfo = ((parts[parts.length - 1].value as forge.asn1.Asn1[])[0])
      const sigOctet = findSignatureOctetString(signerInfo)
      if (sigOctet) {
        const token = await requestTimestampToken(this.material.tsaUrl, sigOctet.value as string)
        if (token) contentInfo = injectTimestamp(contentInfo, token)
      }
    }

    return Buffer.from(asn1.toDer(contentInfo).getBytes(), 'binary')
  }
}

/**
 * Signs the given (final, flattened + certificate-appended) PDF bytes with a
 * PAdES-compliant detached CMS signature over a whole-file ByteRange. Returns
 * the signed PDF bytes. A generous placeholder is reserved so a chain + optional
 * timestamp token always fits.
 */
export async function padesSign(
  pdfBytes: Uint8Array,
  material: SigningMaterial,
): Promise<Uint8Array> {
  // Normalize to a classic cross-reference TABLE. pdf-lib (used by flatten +
  // certificate) emits cross-reference STREAMS by default, which
  // @signpdf/placeholder-plain cannot parse; re-saving with object streams off
  // produces the plain xref table the placeholder writer expects.
  const normalized = await PDFDocument.load(pdfBytes).then((d) =>
    d.save({ useObjectStreams: false }),
  )
  const input = Buffer.from(normalized)
  const withPlaceholder = plainAddPlaceholder({
    pdfBuffer: input,
    reason: 'Digitally sealed by Bevora Sign',
    contactInfo: '',
    name: 'Bevora Sign',
    location: '',
    subFilter: SUBFILTER_ETSI_CADES_DETACHED,
    // Reserve enough room for a cert chain + an RFC-3161 timestamp token.
    signatureLength: material.tsaUrl ? 30000 : 16000,
  })
  const signed = await signpdf.sign(withPlaceholder, new PlatformSigner(material))
  return new Uint8Array(signed)
}

// -------------------------------------------------------------------------
// Verification
// -------------------------------------------------------------------------

export type VerifyResult = {
  // Whether the PDF carries a PAdES signature at all.
  signed: boolean
  // Whether the ByteRange covers the whole file (only the /Contents gap excluded).
  byteRangeCoversFile: boolean
  // Whether the CMS signature verifies (content digest + RSA over signed attrs).
  valid: boolean
  signerSubject?: string
  signerFingerprint?: string
  signingTime?: Date | null
  timestamped?: boolean
  reason?: string
}

function parseByteRange(pdf: Buffer): number[] | null {
  const m = /\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/.exec(pdf.toString('latin1'))
  if (!m) return null
  return [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])]
}

/**
 * Verifies a PAdES signature in a signed PDF: extracts the ByteRange + embedded
 * CMS, confirms the ByteRange covers the whole file (only the signature gap is
 * excluded), recomputes the content digest and checks it against the signed
 * messageDigest attribute, and verifies the RSA signature over the signed
 * attributes with the embedded signer certificate. Tampering with ANY covered
 * byte makes `valid` false.
 *
 * This is signature-integrity verification, NOT chain-of-trust validation (a
 * self-signed platform seal is intentionally not anchored to a public CA).
 */
export function verifyPades(pdfBytes: Uint8Array): VerifyResult {
  const pdf = Buffer.from(pdfBytes)
  const byteRange = parseByteRange(pdf)
  if (!byteRange) return { signed: false, byteRangeCoversFile: false, valid: false, reason: 'no_byterange' }

  const [a, b, c, d] = byteRange
  // The signature `<...>` occupies bytes [b, c); the signed content is
  // everything else. A whole-file ByteRange has a === 0 and c + d === file size.
  const byteRangeCoversFile = a === 0 && c + d === pdf.length && b >= 0 && c > b
  const signedContent = Buffer.concat([pdf.subarray(a, a + b), pdf.subarray(c, c + d)])

  // Extract the hex signature between the angle brackets in the /Contents gap.
  const gap = pdf.subarray(b, c).toString('latin1')
  const lt = gap.indexOf('<')
  const gt = gap.indexOf('>', lt + 1)
  if (lt < 0 || gt < 0) return { signed: false, byteRangeCoversFile, valid: false, reason: 'no_contents' }
  let hex = gap.slice(lt + 1, gt)
  // Strip trailing zero padding added to fill the placeholder.
  hex = hex.replace(/(00)+$/i, '')
  if (hex.length === 0) return { signed: false, byteRangeCoversFile, valid: false, reason: 'empty_contents' }

  try {
    const der = Buffer.from(hex, 'hex')
    const p7Asn1 = asn1.fromDer(util.createBuffer(der.toString('binary')))
    const msg = pkcs7.messageFromAsn1(p7Asn1) as forge.pkcs7.PkcsSignedData

    const cert = msg.certificates?.[0]
    if (!cert) return { signed: true, byteRangeCoversFile, valid: false, reason: 'no_cert' }

    // Locate the SignerInfo in the raw ASN.1 to read signed attributes + signature.
    const signedData = (p7Asn1.value as forge.asn1.Asn1[])[1].value[0] as forge.asn1.Asn1
    const sdParts = signedData.value as forge.asn1.Asn1[]
    const signerInfos = sdParts[sdParts.length - 1]
    const signerInfo = (signerInfos.value as forge.asn1.Asn1[])[0]
    const siChildren = signerInfo.value as forge.asn1.Asn1[]

    // signedAttrs = context [0] (constructed); signature = the universal OCTET STRING.
    const signedAttrsNode = siChildren.find(
      (n) => n.tagClass === asn1.Class.CONTEXT_SPECIFIC && n.type === 0,
    )
    const sigOctet = findSignatureOctetString(signerInfo)
    const unsignedAttrs = siChildren.find(
      (n) => n.tagClass === asn1.Class.CONTEXT_SPECIFIC && n.type === 1,
    )
    if (!signedAttrsNode || !sigOctet) {
      return { signed: true, byteRangeCoversFile, valid: false, reason: 'no_signed_attrs' }
    }

    // 1) Content digest must match the messageDigest signed attribute.
    const contentDigest = md.sha256.create().update(signedContent.toString('binary')).digest().getBytes()
    let messageDigestAttr: string | null = null
    let signingTime: Date | null = null
    for (const attr of signedAttrsNode.value as forge.asn1.Asn1[]) {
      const parts = attr.value as forge.asn1.Asn1[]
      const oid = asn1.derToOid(parts[0].value as string)
      const setVal = (parts[1].value as forge.asn1.Asn1[])[0]
      if (oid === OID_MESSAGE_DIGEST) messageDigestAttr = setVal.value as string
      else if (oid === OID_SIGNING_TIME) {
        try {
          signingTime = asn1.utcTimeToDate(setVal.value as string)
        } catch {
          /* generalized time or unparsable — leave null */
        }
      }
    }
    if (messageDigestAttr == null || messageDigestAttr !== contentDigest) {
      return { signed: true, byteRangeCoversFile, valid: false, reason: 'digest_mismatch' }
    }

    // 2) RSA signature over the DER of the signed attributes (re-tagged as a
    //    universal SET, per RFC 5652).
    const signedAttrsSet = asn1.create(
      asn1.Class.UNIVERSAL,
      asn1.Type.SET,
      true,
      (signedAttrsNode.value as forge.asn1.Asn1[]).slice(),
    )
    const signedAttrsDer = asn1.toDer(signedAttrsSet).getBytes()
    const verifyMd = md.sha256.create()
    verifyMd.update(signedAttrsDer)
    const publicKey = cert.publicKey as forge.pki.rsa.PublicKey
    const sigOk = publicKey.verify(verifyMd.digest().bytes(), sigOctet.value as string)

    return {
      signed: true,
      byteRangeCoversFile,
      valid: sigOk && byteRangeCoversFile,
      signerSubject: cert.subject.attributes
        .map((x) => `${x.shortName || x.name}=${x.value}`)
        .join(', '),
      signerFingerprint: forge.md.sha256
        .create()
        .update(asn1.toDer(pki.certificateToAsn1(cert)).getBytes())
        .digest()
        .toHex(),
      signingTime,
      timestamped: !!unsignedAttrs,
    }
  } catch (err) {
    return {
      signed: true,
      byteRangeCoversFile,
      valid: false,
      reason: err instanceof Error ? err.message : 'verify_error',
    }
  }
}
