import { randomBytes } from 'crypto'

// A secure, human-shareable ONE-TIME password for a teammate added by an org
// admin (Settings → Team). It is generated with CSPRNG entropy on the server,
// argon2-hashed at rest (never stored in plaintext), shown to the admin EXACTLY
// once so they can pass it to the new user, and never returned again by any GET.
//
// 15 random bytes → 20 base64url chars (~120 bits of entropy). Comfortably above
// the 8-char signup minimum, so the new user can immediately log in with the
// Credentials provider and later change it.
export function generateTempPassword(): string {
  return randomBytes(15).toString('base64url')
}
