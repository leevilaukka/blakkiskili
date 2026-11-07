FROM oven/bun:1.4-alpine AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# The website is built once, here, into plain files. The server never builds or runs a
# front-end toolchain. The output is the same on every architecture, so this stage always runs on
# the build machine's own (no QEMU for the arm64 image).
FROM --platform=$BUILDPLATFORM oven/bun:1.4-alpine AS web
WORKDIR /app/web
COPY web/package.json web/bun.lock ./
RUN bun install --frozen-lockfile
COPY shared /app/shared
COPY web ./
RUN bun run build

FROM oven/bun:1.4-alpine
WORKDIR /app
ENV NODE_ENV=production TZ=Europe/Helsinki DB_PATH=/app/data/kili.sqlite \
    BACKUP_DIR=/app/backups BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 WEB_DIST=/app/web-dist
RUN apk add --no-cache tzdata font-dejavu
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY --from=web /app/web/build ./web-dist
RUN mkdir -p /app/data /app/backups && chown bun:bun /app/data /app/backups
USER bun
VOLUME ["/app/data", "/app/backups"]
CMD ["bun", "src/index.ts"]
