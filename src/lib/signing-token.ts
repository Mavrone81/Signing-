import { randomBytes } from 'crypto'

/**
 * Signing-token mint — SERVER ONLY.
 *
 * A signer's token IS the authorization for every unauthenticated signing
 * surface: `/sign/<token>`, `/api/sign/<token>/…` and the envelope link
 * `/e/<token>`. There is no session and no second factor behind any of them, so
 * the token's unguessability is the entire access control.
 *
 * It is therefore minted from `crypto.randomBytes` directly, and never from a
 * general-purpose id helper: a credential's strength must be a property of this
 * module, not of whichever runtime happens to be installed. `engines.node`
 * pins the supported runtime so that is a declared constraint rather than an
 * assumption, and `test/unit/token-entropy.test.ts` asserts the generator
 * rather than the shape of its output.
 *
 * 32 bytes = 256 bits of CSPRNG entropy; base64url so the value is URL-safe
 * with no escaping (43 characters, no padding).
 */
export const SIGNING_TOKEN_BYTES = 32

export function newSigningToken(): string {
  return randomBytes(SIGNING_TOKEN_BYTES).toString('base64url')
}
