# Deployment

Bevora Sign runs on **box 165** at **https://sign.bevorasg.com**.

Deployment is **pull-based**: GitHub Actions never touches the server. The box
polls this repository once a minute and deploys a commit only after CI has
marked it green. This is deliberate — an Actions-push deploy would require a
production SSH key in the secrets of a *public* repository.

```
push to main ──> GitHub Actions ──> refs/ci-pass/<sha> ──> box cron ──> live
                 typecheck                 (the gate)      (every 60s)
                 lint
                 unit + integration
                 production build
                 secret scan (full history)
```

## The gate

`.github/workflows/ci.yml` runs two jobs in parallel — the correctness gate and
a full-history secret scan. A third job, `mark`, runs only if **both** pass, and
its only action is to push a ref named `refs/ci-pass/<sha>`.

That ref existing *is* the green signal. `deploy/auto-deploy-bevorasign.sh`
mirrors those refs and refuses to deploy a commit that has none, so a red build
never reaches production — the box simply keeps serving the last commit that
did pass.

A commit with no marker is a normal state (CI still running, or it failed), so
the script exits 0 and stays quiet rather than logging a failure every minute.

## The box

| | |
|---|---|
| Host | `165.22.246.45` |
| Checkout | `/opt/bevorasign` |
| Compose | `docker-compose.yml` + `docker-compose.prod.yml` + `docker-compose.165.yml` |
| Containers | `bevorasign-app`, `bevorasign-db` |
| App port | `127.0.0.1:13300` (loopback only — never `0.0.0.0`) |
| Vhost | `/etc/nginx/sites-available/sign.bevorasg.com.conf` → `:13300` |
| TLS | Let's Encrypt via `certbot --nginx`, auto-renewing |
| Secrets | `/opt/bevorasign/.env`, `0600`, git-ignored |
| Deploy log | `/var/log/bevorasign-deploy.log` |
| State | `/var/lib/bevorasign/last-deployed.sha`, `…/deploy-FAILED` |
| Backups | `/var/backups/bevorasign/pre-deploy-*.sql.gz` (last 14) |

> **This box is multi-tenant.** It runs many other compose stacks, including
> another developer's production. Every docker command in the deploy script is
> scoped to this stack's own compose project. Never `down`, never `down -v`,
> never a bare `docker system prune`. Run `git remote -v` before touching any
> stack you did not deploy.

TLS terminates at the **host** nginx, which fronts every site on the box. The
containerized nginx in the base compose file is disabled here via an unrequested
profile — a second proxy would be a pointless extra hop.

## First-time provisioning

Clone to `/opt/bevorasign`, write `.env` (see below), then:

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml -f docker-compose.165.yml \
  up -d --build app
cp deploy/nginx-sign.bevorasg.com.conf /etc/nginx/sites-available/sign.bevorasg.com.conf
ln -s /etc/nginx/sites-available/sign.bevorasg.com.conf /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx          # nginx -t before EVERY reload
certbot --nginx -d sign.bevorasg.com
install -m 755 deploy/auto-deploy-bevorasign.sh /root/auto-deploy-bevorasign.sh
crontab -e   # * * * * * /root/auto-deploy-bevorasign.sh >> /var/log/bevorasign-deploy.log 2>&1
```

`docker-compose.prod.yml` runs `prisma migrate deploy` before starting the
server, so every deploy self-migrates.

### Server `.env`

Generate the secrets **on the box** so they never transit anything else.
`DATABASE_URL` points at the compose service name `db`, not localhost.

```
NODE_ENV=production
POSTGRES_USER=bevorasign
POSTGRES_PASSWORD=<openssl rand -hex 24>
POSTGRES_DB=bevorasign
DATABASE_URL=postgresql://bevorasign:<same>@db:5432/bevorasign?schema=public
AUTH_SECRET=<openssl rand -base64 32>
AUTH_URL=https://sign.bevorasg.com
DATA_KEY=<openssl rand -hex 32>          # EXACTLY 64 hex chars
STORAGE_DIR=/data/uploads
MAX_UPLOAD_MB=25
SEED_ADMIN_EMAIL=admin@bevorasg.com
SEED_ADMIN_PASSWORD=<openssl rand -base64 18>
```

> **`DATA_KEY` is not rotatable in place.** It decrypts every stored document
> and every stored secret, including the SMTP password and the OAuth client
> secrets. Losing it means losing access to every uploaded file — permanently.
> Keep a copy off-box.

`AUTH_URL` must be the real `https://` origin: Auth.js derives callback URLs and
cookie security from it, and it is what activates Google/Microsoft SSO. SMTP is
**not** configured by environment — set it in-app under Settings → Email.

## Verifying a deploy

The **only** proof a deploy succeeded is the final line of the log:

```
=== Deploy OK: <sha> ===
```

`HEAD` and the running images both look correct while a deploy is failing, so
neither is evidence. Watch it with:

```bash
tail -f /var/log/bevorasign-deploy.log
```

## Failure modes this is built against

Both were learned from a 4-hour outage of a sibling app on this same box.

**A failed deploy can leave the stack down.** A naive "has the sha changed?"
check then skips forever, because the checkout already fast-forwarded past it.
So the script asks two *independent* questions — is there new code, and is the
app actually running — and acts if either says yes. That makes it self-healing.
The self-heal path deliberately does **not** re-check the ci-pass marker: that
sha was already gated when first deployed, and re-gating would strand a stack
whose marker had since been pruned.

**A pre-deploy dump that needs the database the deploy just stopped fails every
retry.** So the backup is best-effort and never aborts the deploy.

**A deploy-script fix that sits inert in git.** The script copies itself from
the repo to `/root` after each successful deploy, so changes to the deploy logic
actually take effect.

## Rollback

```bash
cd /opt/bevorasign
git reset --hard <last-good-sha>
docker compose -f docker-compose.yml -f docker-compose.prod.yml -f docker-compose.165.yml \
  up -d --build app
echo <last-good-sha> > /var/lib/bevorasign/last-deployed.sha   # else the cron re-pulls main
```

The last line matters: without it the next tick sees `origin/main` ahead and
redeploys the commit you just rolled back.
