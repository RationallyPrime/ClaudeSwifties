# Zero runtime dependencies — the service uses only Bun's standard library, so
# there is no install step and no dependency surface on an internet-facing box.
FROM oven/bun:1.3.14-alpine

WORKDIR /app

COPY --chown=bun:bun package.json tsconfig.json ./
COPY --chown=bun:bun src ./src

ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/data

EXPOSE 8080

RUN mkdir -p /data && chown bun:bun /data
USER bun

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD wget -qO- "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1 || exit 1

CMD ["bun", "run", "src/index.ts"]
