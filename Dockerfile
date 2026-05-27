# =========================================================================
# Backend SaaS — Dockerfile multi-stage
# - Stage `deps`: instala dependencias de produccion con pnpm.
# - Stage `runtime`: copia node_modules + src-saas y arranca node.
#
# El mismo image sirve para `api` y `worker` (el comando lo decide compose):
#   - api:    node src-saas/server.js
#   - worker: node src-saas/worker.js
# =========================================================================

# ----- Stage 1: deps -----
FROM node:20-alpine AS deps

# pnpm via corepack (incluido en node:20+)
RUN corepack enable && corepack prepare pnpm@9 --activate

WORKDIR /app

# Copiar manifests del monorepo para que pnpm respete workspaces
COPY pnpm-workspace.yaml package.json ./
COPY packages/shared-schemas/package.json packages/shared-schemas/
COPY backend/puntoventa/package.json backend/puntoventa/
COPY frontend/frontend_punto_venta/package.json frontend/frontend_punto_venta/
COPY pnpm-lock.yaml* ./

# Solo deps del backend (filtrado por workspace)
RUN pnpm install --filter "backend..." --prod --frozen-lockfile || \
    pnpm install --filter "backend..." --prod

# ----- Stage 2: runtime -----
FROM node:20-alpine AS runtime

ENV NODE_ENV=production \
    NODE_OPTIONS="--enable-source-maps"

# tini para signal forwarding (graceful shutdown en kubernetes/docker)
RUN apk add --no-cache tini curl && \
    addgroup -S app && adduser -S app -G app

WORKDIR /app

# Copiar node_modules hoisteados del monorepo
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/backend/puntoventa/node_modules ./backend/puntoventa/node_modules
COPY --from=deps /app/packages/shared-schemas ./packages/shared-schemas

# Codigo de aplicacion
COPY backend/puntoventa/src-saas ./backend/puntoventa/src-saas
COPY backend/puntoventa/scripts ./backend/puntoventa/scripts
COPY backend/puntoventa/package.json ./backend/puntoventa/package.json
COPY backend/puntoventa/database ./backend/puntoventa/database

WORKDIR /app/backend/puntoventa

USER app

EXPOSE 4000

# Healthcheck: liveness simple. Readiness es /ready (lo chequea el LB).
HEALTHCHECK --interval=20s --timeout=5s --start-period=10s --retries=3 \
    CMD curl -fsS http://localhost:4000/api/saas/health || exit 1

ENTRYPOINT ["/sbin/tini", "--"]

# Default: api. Override en docker-compose para worker.
CMD ["node", "src-saas/server.js"]
