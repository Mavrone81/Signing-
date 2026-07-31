# Bevora Sign — Commercial roadmap (self-sign MVP → multi-tenant SaaS)

Scope selected by the product owner (2026-07-17): P0 #1 (send-for-signature),
#3 (accounts + multi-tenancy), #4 (email); all of P1; all of P2 — including
Google + Microsoft SSO with an IT-admin page to manage the OAuth keys.
Deferred: P0 #2 (HTTPS + domain) — "HTTP last, still testing".

## Hard constraint: SSO needs HTTPS
Google and Microsoft OAuth reject non-HTTPS redirect URIs (only `http://localhost`
is allowed, never a plain-HTTP LAN IP). So the Google/Microsoft SSO + the
IT-admin key management are BUILT now but real SSO logins only complete once
HTTPS + a real hostname are in place. Email/password remains the working login
until then. Everything is wired so SSO activates when HTTPS lands.

## Product direction
Multi-tenant SaaS (confirmed by the accounts + SSO + send-for-signature + billing
choices). Users are global; they belong to Organizations via Memberships.
Documents are tenant-scoped to an Organization.

## Phases (each ships + deploys independently)

### Phase 1 — Foundation (accounts + tenancy + SSO scaffolding + IT-admin keys)
- Models: `Organization`, `Membership(role: owner|admin|member)`, `Invitation`;
  `Document.orgId` (tenant scope). Migration backfills a default org + owner
  memberships + assigns existing docs.
- Email/password **sign-up** (creates User + Organization + owner Membership).
- Tenant-scoped document queries + `canAccessDocument` extended to org membership.
- **Settings → Authentication** (IT-admin only): store encrypted Google +
  Microsoft (Entra) OAuth client id/secret/tenant; Auth.js providers read them.
  Login page shows "Sign in with Google/Microsoft" when enabled (activate on HTTPS).

### Phase 2 — Send-for-signature (the defining feature)
- `Envelope` (a document sent for signing) + `Recipient` (email, name, order,
  status, unique signing token) + fields assigned to a recipient (`Field.recipientId`).
- Tokenized signing route `/sign/[token]` — recipient signs with no account,
  mobile-friendly guided flow; status: sent / viewed / signed / completed / declined.
- Sequential + parallel signing order; finalize when all signed → certificate
  lists every signer.

### Phase 3 — Email notifications
- Invite / reminder / completed (with signed copy) / declined, via the M365
  connector pattern. Configurable sender per deployment.

### Phase 4 — P1 competitiveness
- Templates (reusable doc + fields + recipients); more field types
  (checkbox, initials, radio, dropdown, required/optional, auto name/date-signed);
  status dashboard (search/filter/folders); reminders + expiry + decline;
  downloadable audit-trail report.

### Phase 5 — P2 differentiators / scale
- SSO polish + SCIM; white-label branding per org; public API + webhooks;
  cryptographic PAdES/PKI signatures + RFC-3161 timestamps; object storage
  (S3/R2) + backups/DR; error tracking + rate limiting; Stripe billing;
  Terms/Privacy + PDPA/GDPR data handling.

## Status
- [ ] Phase 1 (in progress)
- [ ] Phase 2
- [ ] Phase 3
- [ ] Phase 4
- [ ] Phase 5
