FROM oven/bun:1.4-alpine AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

FROM oven/bun:1.4-alpine
WORKDIR /app
ENV NODE_ENV=production TZ=Europe/Helsinki DB_PATH=/app/data/kili.sqlite \
    BACKUP_DIR=/app/backups BUN_RUNTIME_TRANSPILER_CACHE_PATH=0
RUN apk add --no-cache tzdata font-dejavu
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
RUN mkdir -p /app/data /app/backups && chown bun:bun /app/data /app/backups
USER bun
VOLUME ["/app/data", "/app/backups"]
CMD ["bun", "src/index.ts"]
