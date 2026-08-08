# Zero runtime dependencies — the service uses only Bun's standard library, so
# there is no install step and no dependency surface on an internet-facing box.
FROM oven/bun:1-alpine

WORKDIR /app

COPY package.json tsconfig.json ./
COPY src ./src

ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/data

EXPOSE 8080

# Runs as root deliberately. Coolify mounts the persistent volume at /data with
# root ownership, and a `USER bun` here would leave the container unable to
# write its own state. If you'd rather drop privileges, set the volume's
# ownership in Coolify first, then add `USER bun` — in that order.

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD wget -qO- "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1 || exit 1

CMD ["bun", "run", "src/index.ts"]
