FROM oven/bun:1.3.6 AS bun-source

FROM node:22.18.0-bookworm-slim AS web-build
WORKDIR /web
COPY web/admin/package.json web/admin/package-lock.json ./
RUN npm ci
COPY web/admin ./
RUN npm run build

FROM node:22.18.0-bookworm-slim AS build
COPY --from=bun-source /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /build
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN ./node_modules/.bin/tsc -p tsconfig.build.json

FROM node:22.18.0-bookworm-slim AS production-dependencies
COPY --from=bun-source /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /build
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

FROM node:22.18.0-bookworm-slim AS runtime
ENV NODE_ENV=production \
    AMAZON_CONFIG_FILE=/app/config.yaml
WORKDIR /app

COPY package.json ./
COPY --from=production-dependencies /build/node_modules ./node_modules
COPY --from=build /build/dist ./dist
COPY --from=web-build /web/dist ./web/admin/dist
COPY docker/healthcheck.mjs ./docker/healthcheck.mjs

RUN groupadd --system --gid 10001 amazon \
    && useradd --system --uid 10001 --gid amazon --home-dir /app --shell /usr/sbin/nologin amazon \
    && mkdir -p /data \
    && chown amazon:amazon /data

USER amazon
EXPOSE 8789
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "/app/docker/healthcheck.mjs"]
ENTRYPOINT ["node", "/app/dist/server.js"]
