FROM node:22-bookworm-slim AS mcp-build
WORKDIR /build/amazon-sp-api-mcp
COPY amazon-sp-api-mcp/package.json amazon-sp-api-mcp/package-lock.json ./
RUN npm ci
COPY amazon-sp-api-mcp/tsconfig.json amazon-sp-api-mcp/tsconfig.build.json ./
COPY amazon-sp-api-mcp/src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim AS oauth-deps
WORKDIR /build/amazon-oauth-service
COPY amazon-oauth-service/package.json amazon-oauth-service/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production \
    AMAZON_CONFIG_FILE=/app/config.yaml
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY amazon-oauth-service/package.json amazon-oauth-service/server.mjs amazon-oauth-service/redis-store.mjs amazon-oauth-service/token-crypto.mjs ./amazon-oauth-service/
COPY --from=oauth-deps /build/amazon-oauth-service/node_modules ./amazon-oauth-service/node_modules
COPY --from=mcp-build /build/amazon-sp-api-mcp/package.json ./amazon-sp-api-mcp/package.json
COPY --from=mcp-build /build/amazon-sp-api-mcp/node_modules ./amazon-sp-api-mcp/node_modules
COPY --from=mcp-build /build/amazon-sp-api-mcp/dist ./amazon-sp-api-mcp/dist
COPY docker/config-loader.mjs docker/docker-entrypoint.mjs docker/healthcheck.mjs ./docker/

RUN groupadd --system --gid 10001 amazon \
    && useradd --system --uid 10001 --gid amazon --home-dir /app --shell /usr/sbin/nologin amazon \
    && mkdir -p /data \
    && chown amazon:amazon /data

USER amazon
EXPOSE 8788 8789
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "/app/docker/healthcheck.mjs"]
ENTRYPOINT ["node", "/app/docker/docker-entrypoint.mjs"]
