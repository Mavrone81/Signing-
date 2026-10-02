// TOKEN GENERATOR GATE — asserts WHICH generator mints signing tokens, not the
// shape of its output.
//
// 🔑 WHY NOT A LENGTH/CHARSET TEST: a UUID is 36 characters of [0-9a-f-], so a
//   loose shape assertion passes against one. It therefore cannot detect a
//   general-purpose id helper being used where a credential is required — the
//   assertion would be green while the wrong generator was in use.
//
// Signing tokens must come from `newSigningToken()` (src/lib/signing-token.ts).
// `uid()` is a client-side id helper and carries NO security responsibility:
// never use it for a token, a key or any other credential.
//
// Written deliberately by a different author than the change it gates: a guard
// written by the author of the code it checks bakes in that author's blind spots.
//
// Scans src/ ONLY. A grep-style assertion that walked test/ would match its own
// source text and pass itself.
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'

const SRC = path.resolve(__dirname, '../../src')

function walk(dir: string): string[] {
  const out: string[] = []
  for (const e of readdirSync(dir)) {
    const p = path.join(dir, e)
    if (statSync(p).isDirectory()) out.push(...walk(p))
    else if (/\.tsx?$/.test(p)) out.push(p)
  }
  return out
}

const FILES = walk(SRC)
const SOURCES = FILES.map((f) => ({ file: path.relative(SRC, f), text: readFileSync(f, 'utf8') }))

describe('R1 — token generators', () => {
  // DENOMINATOR FIRST. A scan over zero files reports zero violations and looks
  // identical to a clean pass, which is the degenerate success.
  it('the scan actually read a meaningful number of source files', () => {
    expect(FILES.length).toBeGreaterThan(50)
    expect(SOURCES.some((s) => s.text.length > 0)).toBe(true)
    console.log(`scanned ${FILES.length} .ts/.tsx files under src/`)
  })

  // CONTROL: the expression must be capable of matching. If `uid(` cannot be
  // found anywhere in src/ then the regex is broken, not the codebase clean —
  // uid() legitimately remains in client components for React keys.
  it('CONTROL: the matcher can fire — uid( is still present in src/ for its legitimate client uses', () => {
    const anyUid = SOURCES.filter((s) => /\buid\(/.test(s.text))
    expect(anyUid.length).toBeGreaterThan(0)
    console.log(`control: uid( appears in ${anyUid.length} file(s) under src/ (client-side React keys etc.)`)
  })

  // ASSERTION 1 — static. No token field may be assigned from uid().
  it('no token is minted from uid() anywhere in src/', () => {
    const TOKEN_FROM_UID = /token\s*:\s*uid\s*\(/g
    const offenders: string[] = []
    for (const { file, text } of SOURCES) {
      const lines = text.split('\n')
      lines.forEach((line, i) => {
        if (TOKEN_FROM_UID.test(line)) offenders.push(`${file}:${i + 1}  ${line.trim()}`)
        TOKEN_FROM_UID.lastIndex = 0
      })
    }
    expect(offenders, `token fields minted from uid():\n${offenders.join('\n')}`).toEqual([])
  })

  // ASSERTION 2 — static, the regeneration map form, which assigns into a Map
  // rather than a `token:` field and so escapes assertion 1.
  it('no token map is populated from uid() in the server token paths', () => {
    const offenders: string[] = []
    for (const { file, text } of SOURCES) {
      if (!/^server\//.test(file)) continue
      text.split('\n').forEach((line, i) => {
        if (/\buid\(\)/.test(line) && /token/i.test(line)) {
          offenders.push(`${file}:${i + 1}  ${line.trim()}`)
        }
      })
    }
    expect(offenders, `token values from uid() in src/server:\n${offenders.join('\n')}`).toEqual([])
  })

  // ASSERTION 3 — behavioural, and independent of any grep. A token must not
  // look like a UUID. This fails if uid() survives even where the static scans
  // miss it (a rename, an indirection, a helper).
  it('a freshly minted token is NOT uuid-shaped and carries >=256 bits', async () => {
    // The generator lives in its own server-only module, so that `uid()` keeps
    // no security responsibility at all.
    const mod = await import('@/lib/signing-token')
    const m = mod as Record<string, unknown>
    const gen = m.newSigningToken ?? m.newToken ?? m.token
    expect(
      typeof gen,
      'no dedicated token generator is exported (expected newSigningToken() in src/lib/signing-token.ts).',
    ).toBe('function')
    const t = (gen as () => string)()
    const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    expect(UUID.test(t), `token is uuid-shaped (${t}) — it must come from newSigningToken()`).toBe(false)
    // base64url of 32 bytes is 43 chars; assert the entropy floor, not a format.
    expect(t.length).toBeGreaterThanOrEqual(43)
    expect(/^[A-Za-z0-9_-]+$/.test(t)).toBe(true)
    // Uniqueness over a real sample — catches a constant or a counter.
    const n = 2000
    const seen = new Set<string>()
    for (let i = 0; i < n; i++) seen.add((gen as () => string)())
    expect(seen.size, `${n} tokens produced ${seen.size} distinct values`).toBe(n)
    console.log(`behavioural: ${n}/${seen.size} distinct, length ${t.length}, not uuid-shaped`)
  })

  // CONTROL for assertion 3: the UUID regex must actually reject a UUID, or
  // "not uuid-shaped" means nothing.
  it('CONTROL: the uuid matcher rejects a real uuid and accepts a base64url token', () => {
    const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    expect(UUID.test('3f2504e0-4f89-41d3-9a0c-0305e82c3301')).toBe(true)
    expect(UUID.test(randomBytes(32).toString('base64url'))).toBe(false)
  })
})
