import { createHash } from 'crypto'

export const sha256hex = (buf: Buffer): string =>
  createHash('sha256').update(buf).digest('hex')
