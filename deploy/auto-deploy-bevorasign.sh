#!/usr/bin/env bash
# Pull-based auto-deploy for Bevora Sign on box 165.22.246.45.
#
# Install (once, as root on the box):
#   cp /opt/bevorasign/deploy/auto-deploy-bevorasign.sh /root/
#   chmod +x /root/auto-deploy-bevorasign.sh
#   crontab -e  ->  * * * * * /root/auto-deploy-bevorasign.sh >> /var/log/bevorasign-deploy.log 2>&1
#
# Safe to run every minute: flock -n makes overlapping runs a no-op.
#
# THIS BOX IS MULTI-TENANT — it runs ~17 compose stacks including other
# developers' production. Every docker command below is scoped to this stack's
# own compose project. Never `down`, never `down -v`, never a bare
# `docker system prune`.
#
# Two failure modes are designed against here, both learned the hard way from
# BamForm's 4-hour outage on this same box:
#
#   1. A deploy that fails partway can leave the stack DOWN, and a naive
#      "has the sha changed?" check then skips forever because the checkout
#      already fast-forwarded. So this script asks TWO independent questions —
#      "is there new code?" AND "is the app actually running?" — and deploys
#      if either says yes. That makes it self-healing.
#   2. A pre-deploy database dump that needs a database the deploy just
#      stopped will fail every retry. So the backup below is best-effort and
#      never aborts the deploy.
#
# The ONLY proof a deploy worked is the `=== Deploy OK: <sha> ===` line at the
# end. HEAD and running images both look correct while a deploy is failing.
set -euo pipefail

REPO_DIR="/opt/bevorasign"
LOCK="/tmp/bevorasign-deploy.lock"
BRANCH="main"
APP_CONTAINER="bevorasign-app"
COMPOSE=(docker compose -f docker-compose.yml -f docker-compose.prod.yml -f docker-compose.165.yml)

STATE_DIR="/var/lib/bevorasign"
LAST_DEPLOYED_FILE="$STATE_DIR/last-deployed.sha"
FAILED_SENTINEL="$STATE_DIR/deploy-FAILED"
BACKUP_DIR="/var/backups/bevorasign"

ts() { date -u '+%Y-%m-%dT%H:%M:%SZ'; }
log() { echo "$(ts)  $*"; }

mkdir -p "$STATE_DIR" "$BACKUP_DIR"

exec 9>"$LOCK"
flock -n 9 || { log "another deploy in progress; skip"; exit 0; }

cd "$REPO_DIR" || { log "FATAL repo missing at $REPO_DIR"; exit 1; }

git fetch --quiet origin "$BRANCH" || { log "fetch failed"; exit 1; }
# CI writes refs/ci-pass/<sha> only after typecheck, lint, the full test suite,
# the production build AND the secret scan have all passed. Mirror those refs
# locally so the gate below can ask whether this exact commit is green.
git fetch --quiet --prune origin "+refs/ci-pass/*:refs/ci-pass/*" || true

REMOTE=$(git rev-parse "origin/$BRANCH")
LOCAL=$(git rev-parse HEAD)
LAST_DEPLOYED=""
[ -f "$LAST_DEPLOYED_FILE" ] && LAST_DEPLOYED=$(cat "$LAST_DEPLOYED_FILE")

# Question 2, asked independently of the sha: is the app actually up? A stack
# that is down must be brought back even when there is no new commit — that is
# the whole self-heal. `docker inspect` on a missing container exits non-zero,
# which `|| true` absorbs into an empty string.
RUNNING=$(docker inspect -f '{{.State.Running}}' "$APP_CONTAINER" 2>/dev/null || true)

if [ "$LAST_DEPLOYED" = "$REMOTE" ] && [ "$RUNNING" = "true" ]; then
  exit 0   # up to date AND healthy -> quiet, no log noise
fi

if [ "$LAST_DEPLOYED" = "$REMOTE" ]; then
  # Self-heal only: this sha was already gated when it was first deployed, so
  # do NOT re-check the marker here. Re-gating would mean a green commit whose
  # marker was later pruned could never be restarted — the stack would stay
  # down precisely when the self-heal is what is needed.
  log "code is current but $APP_CONTAINER is not running (state='${RUNNING:-absent}') -> self-healing"
elif ! git rev-parse --verify --quiet "refs/ci-pass/${REMOTE}" >/dev/null; then
  # New code that CI has not (yet) marked green. Exit 0, not 1: an in-flight
  # or failed run is a normal state, not a deploy failure, and must not write
  # the FAILED sentinel or spam the log every minute. The box keeps serving
  # the last commit that did pass until the marker appears.
  HELD="${LAST_DEPLOYED:0:8}"
  log "origin/$BRANCH is ${REMOTE:0:8} but no ci-pass marker yet; holding at ${HELD:-<none>}"
  exit 0
elif [ "$LOCAL" = "$REMOTE" ]; then
  log "retrying previously-failed deploy of ${REMOTE:0:8}"
else
  log "new commit ${REMOTE:0:8} (was ${LOCAL:0:8}) -> deploying"
fi

# Docs-only diffs skip the rebuild but still count as deployed. Measured from
# the last SUCCESSFULLY deployed sha, so a retry after a failed build still
# sees the real code diff rather than an empty one.
DOCS_ONLY=false
if [ -n "$LAST_DEPLOYED" ] && [ "$RUNNING" = "true" ] \
   && ! git diff --name-only "$LAST_DEPLOYED" "$REMOTE" | grep -qvE '^(docs/|.*\.md$)'; then
  DOCS_ONLY=true
fi

# Best-effort pre-deploy dump. Deliberately NOT fatal: if postgres is down,
# insisting on a dump here would block the very deploy that brings it back.
if [ "$DOCS_ONLY" = false ] && [ "$(docker inspect -f '{{.State.Running}}' bevorasign-db 2>/dev/null || true)" = "true" ]; then
  DUMP="$BACKUP_DIR/pre-deploy-$(date -u '+%Y%m%dT%H%M%SZ').sql.gz"
  if docker exec bevorasign-db pg_dumpall -U "${POSTGRES_USER:-digital_signing}" 2>/dev/null | gzip >"$DUMP"; then
    log "pre-deploy dump -> $DUMP ($(du -h "$DUMP" | cut -f1))"
    ls -1t "$BACKUP_DIR"/pre-deploy-*.sql.gz 2>/dev/null | tail -n +15 | xargs -r rm -f
  else
    rm -f "$DUMP"
    log "WARN pre-deploy dump failed; continuing (deploy must not be blocked by backup)"
  fi
else
  log "skipping pre-deploy dump (docs-only, or database not running)"
fi

git reset --hard "origin/$BRANCH"   # code only; .env + named volumes survive

if [ "$DOCS_ONLY" = true ]; then
  log "docs-only change; skipping rebuild"
elif "${COMPOSE[@]}" up -d --build app; then
  # Scoped to dangling images only, and never to volumes. Other tenants on
  # this box must not lose images to our prune.
  docker image prune -f >/dev/null 2>&1 || true
else
  echo "$REMOTE  $(ts)" >"$FAILED_SENTINEL"
  log "BUILD FAILED for ${REMOTE:0:8}; last-deployed stays at ${LAST_DEPLOYED:-<none>}, retry next tick"
  exit 1
fi

# Health gate. The app is behind the host nginx, so probe the loopback port
# the container publishes rather than the public URL — this proves the
# container serves, independently of TLS or DNS.
HEALTHY=false
for attempt in 1 2 3 4 5 6 7 8 9 10; do
  CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1:13300/ || true)
  case "$CODE" in
    200|302|307) HEALTHY=true; log "healthy after $attempt attempt(s) (HTTP $CODE)"; break ;;
  esac
  sleep 3
done

if [ "$HEALTHY" != true ]; then
  echo "$REMOTE  $(ts)" >"$FAILED_SENTINEL"
  log "HEALTH CHECK FAILED for ${REMOTE:0:8} after 10 attempts; retry next tick"
  exit 1
fi

echo "$REMOTE" >"$LAST_DEPLOYED_FILE"
rm -f "$FAILED_SENTINEL"

# Keep the box copy of this script in step with the repo, so a fix to the
# deploy logic actually takes effect instead of sitting inert in git — the
# exact trap that made every BamForm deploy-script fix a no-op for weeks.
if ! cmp -s "$REPO_DIR/deploy/auto-deploy-bevorasign.sh" /root/auto-deploy-bevorasign.sh 2>/dev/null; then
  cp "$REPO_DIR/deploy/auto-deploy-bevorasign.sh" /root/auto-deploy-bevorasign.sh
  chmod +x /root/auto-deploy-bevorasign.sh
  log "deploy script on box refreshed from repo"
fi

log "=== Deploy OK: ${REMOTE:0:7} ==="
