# Bevora Sign

Self-hosted e-signature platform. Upload a PDF, place fields on it, send it to
recipients, and collect legally-traceable signatures — producing a
cryptographically signed output file and a full audit trail.

Target deployment: **https://sign.bevorasg.com** (DNS is live; the box is not
yet provisioned — see [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md)).

## What it does

- **Documents** — upload a PDF (25 MB cap), place signature, initials, text,
  date, checkbox, radio and dropdown fields on any page, then send for signing.
- **Recipients** — multiple signers per document, each with their own tokenised
  signing link, plus reminders, decline handling and per-document expiry.
- **Signing output** — fields are flattened into the PDF, an audit certificate
  page is appended (signer name, email, IP, timestamps, and the SHA-256 of both
  the original and signed bytes), and the result is signed with a PKCS#12
  certificate (PAdES, via `@signpdf`).
- **Templates** — save a field layout once and reuse it on new documents.
- **Organizations** — multi-tenant. Users belong to organizations via
  memberships (`owner` / `admin` / `member`); documents are org-scoped.
- **White-label branding** — each org can set its own name, accent colour and
  logo, applied across the app, the signer page and notification emails.
- **REST API + webhooks** — `/api/v1` with API-key auth, and outbound webhooks
  signed with an `X-BevoraSign-Signature: sha256=…` HMAC header.
- **SSO** — Google and Microsoft (Entra) OAuth, with the client keys managed
  from an in-app IT-admin page and stored encrypted.

Documents are **encrypted at rest** (AES-256-GCM under `DATA_KEY`); the
plaintext PDF exists only in memory, while being served to an authorized caller.

## Stack

Next.js 15 (App Router, standalone output) · React 19 · TypeScript ·
Prisma 6 / PostgreSQL 16 · Auth.js v5 · Tailwind v4 · pdf-lib + pdf.js ·
Vitest · Playwright.

## Local development

Requires **Node 22** and pnpm 9.

```bash
cp .env.example .env          # then fill in the values (see below)
pnpm install
docker compose up -d db       # Postgres on 127.0.0.1:13301
pnpm prisma migrate deploy
pnpm db:seed                  # creates the admin from SEED_ADMIN_* in .env
pnpm dev                      # http://localhost:3000
```

### Required environment

| Variable | Notes |
|---|---|
| `DATABASE_URL` | Postgres connection string. |
| `AUTH_SECRET` | Session signing key. `openssl rand -base64 32` |
| `DATA_KEY` | At-rest encryption key. **Exactly 64 hex chars** — `openssl rand -hex 32` |
| `AUTH_URL` | Canonical external URL. Must be `https://` for SSO to work. |
| `STORAGE_DIR` | Encrypted blob root. Defaults to `.uploads`. |
| `MAX_UPLOAD_MB` | Per-PDF upload cap. Defaults to 25. |
| `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD` | Consumed by `pnpm db:seed`. |

> `DATA_KEY` is **not rotatable in place** — it decrypts every stored document
> and every stored secret. Losing it means losing access to every uploaded file.

SMTP is *not* configured by environment: sign in as an admin and set it under
**Settings → Email**. The password is stored encrypted under `DATA_KEY`.

## Tests

```bash
pnpm test          # vitest — unit + integration (integration needs DATABASE_URL)
pnpm test:e2e      # Playwright — real Chromium against a real build
npx tsc --noEmit   # type-check
pnpm lint
```

## Deployment

Push to `main`. GitHub Actions runs the correctness gate (type-check, lint,
tests, production build) plus a full-history secret scan, and records success by
pushing a `refs/ci-pass/<sha>` marker. The deploy host polls `main` under a lock
and rebuilds only for a commit carrying that marker, so a red build never
reaches production. See [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md).

## Licence

Proprietary — © Bevora.
