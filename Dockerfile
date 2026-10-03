ARG BUN_IMAGE=oven/bun:1.3.11@sha256:0733e50325078969732ebe3b15ce4c4be5082f18c4ac1a0f0ca4839c2e4e42a7

FROM ${BUN_IMAGE} AS verify
RUN apt-get update && apt-get install -y --no-install-recommends git python3 build-essential procps && rm -rf /var/lib/apt/lists/*
RUN mkdir -p /app /prod && chown bun:bun /app /prod
WORKDIR /app
USER bun
COPY --chown=bun:bun package.json bun.lock ./
COPY --chown=bun:bun scripts/vendor/transpect-fontmap-to-unicode ./scripts/vendor/transpect-fontmap-to-unicode
RUN bun install --frozen-lockfile
COPY --chown=bun:bun . .
COPY --from=history --chown=bun:bun /history.bundle /tmp/history.bundle
RUN git init && git fetch /tmp/history.bundle HEAD && git reset --mixed FETCH_HEAD && rm /tmp/history.bundle
# The context must be exactly HEAD: no modified, untracked or gitignored files
# (.env, logs, local databases) under any path the runtime image copies.
RUN test -z "$(git status --porcelain=v1 --untracked-files=all --ignored=matching -- src migrations scripts docs/v4 compose package.json bun.lock)"
# Supply-chain gates, as in CI. A newly published advisory blocks a rebuild of an
# already-reviewed commit: see docs/operations/supply-chain.md for the escape hatch.
RUN bun audit && bun run sec:vendored-pdfjs
RUN bun run typecheck
# Before tests: the built-in embedding test needs the verified model, not a
# gitignored local models/ copy that happens to ride in the build context.
RUN bun scripts/prepare-memory-model.ts
RUN bun test --timeout 30000
RUN mkdir -p /prod/scripts/vendor && cp package.json bun.lock /prod/ && cp -R scripts/vendor/transpect-fontmap-to-unicode /prod/scripts/vendor/ && cd /prod && bun install --frozen-lockfile --production
RUN git rev-parse HEAD > /tmp/qoopia-verify-passed

FROM ${BUN_IMAGE} AS runtime
ARG QOOPIA_GIT_SHA
# apt is not pinned to a snapshot (that would freeze security updates), so record
# the OS package set this image actually ships, bubblewrap included.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates bubblewrap procps && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /app && dpkg-query -W -f='${Package} ${Version} ${Architecture}\n' > /app/os-packages.txt && chmod 0444 /app/os-packages.txt
WORKDIR /app
COPY package.json bun.lock ./
COPY --from=verify /prod/node_modules ./node_modules
COPY --from=verify /app/src ./src
COPY --from=verify /app/migrations ./migrations
COPY --from=verify /app/models ./models
COPY --from=verify /app/scripts/migrate.ts ./scripts/migrate.ts
COPY --from=verify /app/scripts/check-db-integrity.ts ./scripts/check-db-integrity.ts
COPY --from=verify /app/scripts/validate-runtime-config.ts ./scripts/validate-runtime-config.ts
COPY --from=verify /app/scripts/release-stamp.ts ./scripts/release-stamp.ts
COPY --from=verify /app/scripts/v4-backfill.ts ./scripts/v4-backfill.ts
COPY --from=verify /app/scripts/v4-verify.ts ./scripts/v4-verify.ts
COPY --from=verify /app/scripts/v4-backup.ts ./scripts/v4-backup.ts
COPY --from=verify /app/scripts/v4-export.ts ./scripts/v4-export.ts
COPY --from=verify /app/scripts/v4-import.ts ./scripts/v4-import.ts
COPY --from=verify /app/scripts/v4-rollback-rehearsal.ts ./scripts/v4-rollback-rehearsal.ts
COPY --from=verify /app/scripts/v4-gate-verify.ts ./scripts/v4-gate-verify.ts
COPY --from=verify /app/scripts/v4-runtime-acceptance.ts ./scripts/v4-runtime-acceptance.ts
COPY --from=verify /app/scripts/v4-rollout-gate.ts ./scripts/v4-rollout-gate.ts
COPY --from=verify /app/docs/v4/export-table-policy.json ./docs/v4/export-table-policy.json
COPY --from=verify /app/docs/v4/export-schema-columns.json ./docs/v4/export-schema-columns.json
COPY --from=verify /app/compose/docker-compose.v4.yml ./compose/docker-compose.v4.yml
# Keep the final stage dependent on verification. BuildKit may prune an
# unrelated stage even when it appears earlier in the Dockerfile.
COPY --from=verify /tmp/qoopia-verify-passed /tmp/qoopia-verify-passed
# Stamp only the commit that verification actually checked.
RUN test "$(cat /tmp/qoopia-verify-passed)" = "${QOOPIA_GIT_SHA}"
RUN bun scripts/release-stamp.ts --sha "${QOOPIA_GIT_SHA}" --output /app/release.json
ENV NODE_ENV=production
ENV QOOPIA_RELEASE_STAMP_PATH=/app/release.json
# Replace every label inherited from the oven/bun base; release:build passes the values.
ARG QOOPIA_VERSION
ARG QOOPIA_CREATED
LABEL org.opencontainers.image.title="Qoopia" \
  org.opencontainers.image.description="Qoopia memory server" \
  org.opencontainers.image.url="https://qoopia.ai" \
  org.opencontainers.image.documentation="https://github.com/qoopia/qoopia-source" \
  org.opencontainers.image.source="https://github.com/qoopia/qoopia-source" \
  org.opencontainers.image.vendor="Qoopia" \
  org.opencontainers.image.licenses="MIT" \
  org.opencontainers.image.version="${QOOPIA_VERSION}" \
  org.opencontainers.image.created="${QOOPIA_CREATED}" \
  org.opencontainers.image.revision="${QOOPIA_GIT_SHA}"
USER bun
CMD ["bun", "run", "start"]
