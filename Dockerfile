# Backend TradeNova - Render standalone image
FROM node:20-alpine

ENV NODE_ENV=production \
    NODE_OPTIONS="--enable-source-maps"

RUN apk add --no-cache tini curl && \
    addgroup -S app && adduser -S app -G app

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY src-saas ./src-saas
COPY scripts ./scripts
COPY database ./database

USER app

EXPOSE 10000

HEALTHCHECK --interval=20s --timeout=5s --start-period=20s --retries=3 \
    CMD curl -fsS http://localhost:${PORT:-10000}/api/saas/health || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "src-saas/server.js"]
