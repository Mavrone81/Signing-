// @vitest-environment node
//
// Exercises the REAL migration.sql file for
// 20260921120000_signing_certificate_per_org against disposable, minimal
// pre-migration fixtures — not a reimplementation of its logic. Each test
// gets its own throwaway Postgres schema (dropped in afterEach) so cases
// never interact and never touch the app's `public` schema.
//
// Why a single interactive transaction: the migration's own guard must be
// asserted AT RUN TIME, inside ITS transaction, against live data — not a
// preflight count taken by this test harness beforehand (that could go
// stale exactly like the preflight the brief warns about). So this harness
// only ever (1) creates the fixture rows, then (2) runs the unmodified
// migration file, and reads results/errors — it never computes the "right"
// orgId itself.
import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { prisma } from '../../src/lib/db'

const MIGRATION_SQL = fs.readFileSync(
  path.join(
    __dirname,
    '../../prisma/migrations/20260921120000_signing_certificate_per_org/migration.sql',
  ),
  'utf8',
)

// Splits the migration file into individually-executable statements, treating
// a `$$ ... $$` dollar-quoted body (the DO block) as opaque so semicolons
// inside it are never mistaken for statement boundaries. Strips the file's
// own BEGIN/COMMIT: this harness supplies the transaction boundary itself via
// prisma.$transaction, which pins every statement to one connection — the
// same connection the migration's LOCK TABLE and DO block need to see each
// other's effects within a single atomic run.
function statementsOf(sql: string): string[] {
  const stripped = sql.replace(/^\s*BEGIN;\s*$/m, '').replace(/^\s*COMMIT;\s*$/m, '')
  const out: string[] = []
  let cur = ''
  let inDollar = false
  let i = 0
  while (i < stripped.length) {
    if (stripped.startsWith('$$', i)) {
      inDollar = !inDollar
      cur += '$$'
      i += 2
      continue
    }
    // A `-- ...` line comment can itself contain a `;` (prose, as in "is
    // unambiguous; fail closed otherwise") — that must never be mistaken for
    // a statement boundary, dollar-quoted or not, so skip the whole comment
    // before the semicolon scan below ever sees it.
    if (!inDollar && stripped.startsWith('--', i)) {
      const eol = stripped.indexOf('\n', i)
      const end = eol === -1 ? stripped.length : eol + 1
      cur += stripped.slice(i, end)
      i = end
      continue
    }
    const ch = stripped[i]
    if (ch === ';' && !inDollar) {
      if (cur.trim()) out.push(cur.trim())
      cur = ''
      i += 1
      continue
    }
    cur += ch
    i += 1
  }
  if (cur.trim()) out.push(cur.trim())
  return out
}

const schemas: string[] = []

async function freshSchema(): Promise<string> {
  const name = `migtest_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  schemas.push(name)
  await prisma.$executeRawUnsafe(`CREATE SCHEMA "${name}"`)
  await prisma.$executeRawUnsafe(`
    CREATE TABLE "${name}"."Organization" (
      "id" TEXT PRIMARY KEY,
      "slug" TEXT,
      "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `)
  await prisma.$executeRawUnsafe(`
    CREATE TABLE "${name}"."SigningCertificate" (
      "id" TEXT PRIMARY KEY,
      "active" BOOLEAN NOT NULL DEFAULT true,
      "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `)
  await prisma.$executeRawUnsafe(
    `CREATE INDEX "SigningCertificate_active_idx" ON "${name}"."SigningCertificate"("active")`,
  )
  return name
}

async function createOrg(schema: string, id: string, slug: string, createdAt: Date) {
  await prisma.$executeRawUnsafe(
    `INSERT INTO "${schema}"."Organization" ("id", "slug", "createdAt") VALUES ($1, $2, $3)`,
    id,
    slug,
    createdAt,
  )
}

async function createUnassignedCert(schema: string, id: string) {
  await prisma.$executeRawUnsafe(
    `INSERT INTO "${schema}"."SigningCertificate" ("id") VALUES ($1)`,
    id,
  )
}

// Runs the real migration file's statements against `schema`, inside one
// transaction so the migration's own LOCK TABLE / DO block see a single
// consistent connection — exactly the atomicity the migration relies on.
async function runMigration(schema: string): Promise<void> {
  const statements = statementsOf(MIGRATION_SQL)
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL search_path TO "${schema}"`)
    for (const stmt of statements) {
      await tx.$executeRawUnsafe(stmt)
    }
  })
}

afterEach(async () => {
  while (schemas.length) {
    const name = schemas.pop()!
    await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${name}" CASCADE`)
  }
})

describe('signing_certificate_per_org migration — run-time org-count guard', () => {
  it('leaves the certificate UNASSIGNED (never cross-org) when MORE THAN ONE organization exists — the migration still succeeds', async () => {
    const schema = await freshSchema()
    await createOrg(schema, 'org-a', 'org-a-slug', new Date('2026-01-01'))
    await createOrg(schema, 'org-b', 'org-b-slug', new Date('2026-02-01'))
    await createUnassignedCert(schema, 'cert-1')

    // A production deploy cannot be made to fail just because more than one
    // org already exists (owner ruling: orgs are created by users at any time, so a
    // live deployment almost certainly has several) — so this is a SUCCESS
    // that assigns nothing, not an abort. "exactly one org" is the only case
    // that attaches; this is the "otherwise leave unassigned" case.
    await expect(runMigration(schema)).resolves.toBeUndefined()

    const rows = await prisma.$queryRawUnsafe<{ orgId: string | null }[]>(
      `SELECT "orgId" FROM "${schema}"."SigningCertificate"`,
    )
    expect(rows).toEqual([{ orgId: null }])
    // Neither org — this is the no-cross-assignment guarantee, not just "not org-a".
    expect(rows[0].orgId).not.toBe('org-a')
    expect(rows[0].orgId).not.toBe('org-b')
  })

  it('attaches an unassigned certificate to the org when EXACTLY ONE org exists', async () => {
    const schema = await freshSchema()
    await createOrg(schema, 'org-solo', 'solo', new Date('2026-01-01'))
    await createUnassignedCert(schema, 'cert-1')

    await runMigration(schema)

    const rows = await prisma.$queryRawUnsafe<{ orgId: string }[]>(
      `SELECT "orgId" FROM "${schema}"."SigningCertificate"`,
    )
    expect(rows).toEqual([{ orgId: 'org-solo' }])
  })

  it('still fails closed with a readable message when NO organization exists (existing guard, preserved)', async () => {
    const schema = await freshSchema()
    await createUnassignedCert(schema, 'cert-1')

    await expect(runMigration(schema)).rejects.toThrow(
      /no organization to assign it to/,
    )
  })

  it('control: with no unassigned certificate at all, the guard never fires regardless of org count', async () => {
    const schema = await freshSchema()
    await createOrg(schema, 'org-a', 'a', new Date('2026-01-01'))
    await createOrg(schema, 'org-b', 'b', new Date('2026-02-01'))
    // No SigningCertificate rows at all — a fresh install.

    await expect(runMigration(schema)).resolves.toBeUndefined()

    const cols = await prisma.$queryRawUnsafe<{ column_name: string; is_nullable: string }[]>(
      `SELECT column_name, is_nullable FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'SigningCertificate' AND column_name = 'orgId'`,
      schema,
    )
    // Nullable, not NOT NULL: a cert can legitimately sit unassigned forever
    // (the multi-org case above), so the schema must allow that permanently,
    // not just transiently inside the migration's own transaction.
    expect(cols).toEqual([{ column_name: 'orgId', is_nullable: 'YES' }])
  })
})
