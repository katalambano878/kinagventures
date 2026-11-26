# syntax=docker/dockerfile:1
# Doctor Barns Tech standard Dockerfile for Next.js on Coolify (fast deploys).
# Needs `output: "standalone"` in next.config. See README.md in this folder.
#
# Why it is fast:
#  - npm/pnpm/yarn and Next.js build caches persist between deploys (BuildKit cache mounts)
#  - the final image holds only Next's standalone server (~150-300 MB, not 1.5 GB of node_modules)
#  - files are copied in with --chown (never `chown -R`, which rewrites every file into a new layer)
# Coolify injects ARG lines for build-time variables (NEXT_PUBLIC_* etc.) itself.

FROM node:22-alpine AS base
RUN apk add --no-cache libc6-compat
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

FROM base AS deps
COPY package.json package-lock.json* pnpm-lock.yaml* yarn.lock* ./
# If the repo uses patch-package (a "postinstall" script), uncomment so patches apply during install:
# COPY patches ./patches
RUN --mount=type=cache,id=npm,target=/root/.npm,sharing=locked \
    --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store,sharing=locked \
    --mount=type=cache,id=yarn,target=/usr/local/share/.cache/yarn,sharing=locked \
    if [ -f pnpm-lock.yaml ]; then corepack enable pnpm && pnpm install --frozen-lockfile; \
    elif [ -f yarn.lock ]; then corepack enable yarn && yarn install --frozen-lockfile; \
    else npm ci --no-audit --no-fund; fi

FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# The Next.js cache id is per app (Coolify's resource uuid), so apps never share a cache.
ARG COOLIFY_RESOURCE_UUID=local
RUN --mount=type=cache,id=next-${COOLIFY_RESOURCE_UUID},target=/app/.next/cache,sharing=locked \
    if [ -f pnpm-lock.yaml ]; then corepack enable pnpm && pnpm run build; \
    elif [ -f yarn.lock ]; then corepack enable yarn && yarn run build; \
    else npm run build; fi

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
RUN addgroup -S app && adduser -S app -G app && chown app:app /app
# Uploaded files (buckets "products" and "site-assets") live on a volume mounted at
# STORAGE_ROOT, never in the image. The empty directory is owned by the app
# user so a fresh named volume mounted here is writable.
ENV STORAGE_ROOT=/app/storage
RUN mkdir -p /app/storage && chown app:app /app/storage
COPY --from=builder --chown=app:app /app/public ./public
COPY --from=builder --chown=app:app /app/.next/standalone ./
COPY --from=builder --chown=app:app /app/.next/static ./.next/static
USER app
EXPOSE 3000
CMD ["node", "server.js"]
