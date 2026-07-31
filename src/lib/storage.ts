import { promises as fs } from 'fs'
import path from 'path'
import { env } from '@/env'
import { encrypt, decrypt } from './crypto'

// Encrypted, traversal-guarded filesystem object store. Keys are POSIX-style
// relative paths, namespaced per document (e.g. "doc1/original.pdf"). Every
// object is written encrypt()-ed (AES-256-GCM under DATA_KEY) and read back
// decrypt()-ed, so the on-disk bytes under STORAGE_DIR are never plaintext.
const ROOT = path.resolve(env.STORAGE_DIR)

function resolveKey(key: string): string {
  if (key.includes('..') || key.startsWith('/') || path.isAbsolute(key)) {
    throw new Error('Invalid storage key (path traversal)')
  }
  const normalized = path.normalize(key)
  if (normalized.includes('..') || path.isAbsolute(normalized)) {
    throw new Error('Invalid storage key (path traversal)')
  }
  const abs = path.resolve(ROOT, normalized)
  if (abs !== ROOT && !abs.startsWith(ROOT + path.sep)) {
    throw new Error('Invalid storage key (path traversal)')
  }
  return abs
}

export async function putObject(key: string, buf: Buffer): Promise<void> {
  const abs = resolveKey(key)
  await fs.mkdir(path.dirname(abs), { recursive: true })
  await fs.writeFile(abs, encrypt(buf))
}

export async function getObject(key: string): Promise<Buffer> {
  const abs = resolveKey(key)
  const raw = await fs.readFile(abs)
  return decrypt(raw)
}

export async function deleteObject(key: string): Promise<void> {
  const abs = resolveKey(key)
  // Tolerate a missing file: reset-to-draft may run against a signedKey whose
  // blob was never written (or was already removed), and that must not throw.
  try {
    await fs.unlink(abs)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
}
