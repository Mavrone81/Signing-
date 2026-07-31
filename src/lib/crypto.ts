import { createCipheriv, createDecipheriv, randomBytes } from 'crypto'
import { env } from '@/env'

// AES-256-GCM at-rest encryption, keyed by DATA_KEY (64 hex chars = 32 bytes).
// Wire format: iv(12) | authTag(16) | ciphertext. Fresh random IV per call.
// Decryption fails loudly (throws) on any tamper — GCM auth tag verification
// is not caught or suppressed here.
const KEY = Buffer.from(env.DATA_KEY, 'hex')

export function encrypt(buf: Buffer): Buffer {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', KEY, iv)
  const enc = Buffer.concat([cipher.update(buf), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), enc])
}

export function decrypt(buf: Buffer): Buffer {
  const iv = buf.subarray(0, 12)
  const tag = buf.subarray(12, 28)
  const data = buf.subarray(28)
  const decipher = createDecipheriv('aes-256-gcm', KEY, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(data), decipher.final()])
}
