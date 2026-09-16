# syntax=docker/dockerfile:1.7
#
# Production image.
#
# Multi-stage so the runtime layer carries no source, no dev dependencies and no
# build toolchain. The final image runs as an unprivileged user on a distroless-
# style Alpine base, which is the difference between a container escape being a
# root shell and being nothing much.

# ---------------------------------------------------------------------------
# 1. Dependencies
# ---------------------------------------------------------------------------
FROM node:22-alpine AS deps
WORKDIR /app

# libc6-compat is needed by some prebuilt native modules on Alpine's musl.
RUN apk add --no-cache libc6-compat

# Only the manifests, so this layer is cached until dependencies actually change.
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

# ---------------------------------------------------------------------------
# 2. Build
# ---------------------------------------------------------------------------
FROM node:22-alpine AS builder
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# The build must not require runtime secrets. Everything that reads the
# environment is lazily initialised (see src/server/db/client.ts), so this
# succeeds with nothing configured — which is what keeps production credentials
# out of the build pipeline.
ENV NEXT_TELEMETRY_DISABLED=1
ENV NODE_ENV=production
RUN npm run build

# ---------------------------------------------------------------------------
# 3. Runtime
# ---------------------------------------------------------------------------
FROM node:22-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

RUN apk add --no-cache libc6-compat wget && \
    addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 --ingroup nodejs nextjs

# `output: 'standalone'` emits a minimal server plus only the node_modules it
# actually traced, so the runtime image carries neither the source tree nor the
# dev dependency graph.
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public ./public

# Migrations and the runner, so a deployment can apply them before serving.
COPY --from=builder --chown=nextjs:nodejs /app/drizzle ./drizzle
COPY --from=builder --chown=nextjs:nodejs /app/scripts ./scripts

USER nextjs

EXPOSE 3000

# Readiness, not just liveness: the endpoint returns 503 when the database is
# unreachable, so an instance that cannot serve is pulled from the pool.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://127.0.0.1:3000/api/v1/health || exit 1

CMD ["node", "server.js"]
