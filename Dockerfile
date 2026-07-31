# Digital Signing — production image (Next.js standalone).
# Adapted from the Enshrine VirtualOffice Dockerfile pattern.
FROM node:22-alpine AS base
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
WORKDIR /app

# --- deps ---
FROM base AS deps
# scripts/ is needed here too: package.json's `postinstall` hook
# (copy-pdf-worker.mjs) runs during `pnpm install` and would fail without it.
COPY package.json pnpm-lock.yaml ./
COPY scripts ./scripts
RUN pnpm install --frozen-lockfile

# --- build ---
FROM base AS builder
# Build-time placeholders so eager module init (Prisma client, env/crypto
# validation in src/env.ts) never trips during `next build`. Real values are
# injected at runtime via .env; authed pages are force-dynamic so nothing
# DB-hits at build time.
ENV DATABASE_URL="postgresql://placeholder:placeholder@localhost:5432/placeholder?schema=public"
ENV AUTH_SECRET="build-time-placeholder-not-used-at-runtime"
# DATA_KEY must be exactly 64 hex chars to pass src/env.ts validation.
ENV DATA_KEY="0000000000000000000000000000000000000000000000000000000000000000"
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# prebuild hook (scripts/copy-pdf-worker.mjs) copies the pdf.js worker into
# public/ before `next build` runs — it is also committed, so this is
# belt-and-braces even if the hook were ever skipped.
RUN pnpm prisma generate && pnpm build

# --- runtime (standalone) ---
FROM base AS runner
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
WORKDIR /app
RUN addgroup -g 1001 -S nodejs && adduser -S nextjs -u 1001
# Uploads root — chown so a fresh named volume mounted here inherits nextjs
# ownership (the container runs as the non-root nextjs user).
RUN mkdir -p /data/uploads && chown -R nextjs:nodejs /data
# CRITICAL: `output:'standalone'` does NOT auto-include `public/`. The pdf.js
# viewer loads /pdf.worker.min.mjs from public/ — without this line the PDF
# viewer silently breaks in production. Do not remove.
COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

# The `prisma` CLI (needed at container start to run `prisma migrate deploy`)
# is a devDependency, so Next's standalone trace deliberately excludes it —
# only the runtime-imported `@prisma/client` gets traced in. pnpm's
# node_modules also uses symlinks into a `.pnpm` content store, so copying
# `node_modules/prisma` out of the builder stage would just be a dangling
# symlink here. Installing the CLI fresh via npm (flat, self-contained, no
# store dependency) sidesteps both problems; version pinned to match the
# `prisma` devDependency in package.json exactly.
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/prisma ./prisma
RUN PRISMA_VERSION=$(node -p "require('./package.json').devDependencies.prisma.replace(/^[\^~]/, '')") \
    && npm install -g prisma@${PRISMA_VERSION}

USER nextjs
EXPOSE 3000
CMD ["node", "server.js"]
