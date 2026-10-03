ARG BUN_IMAGE=oven/bun:1.3.11@sha256:0733e50325078969732ebe3b15ce4c4be5082f18c4ac1a0f0ca4839c2e4e42a7

# Gate the sign-in image like the server image: typecheck plus the tests that
# cover the code bundled below (sign-in, consent, profile, devices, bridges,
# analytics, brand, newsletter).
FROM ${BUN_IMAGE} AS verify
RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*
RUN mkdir -p /app && chown bun:bun /app
WORKDIR /app
USER bun
COPY --chown=bun:bun package.json bun.lock ./
COPY --chown=bun:bun scripts/vendor/transpect-fontmap-to-unicode ./scripts/vendor/transpect-fontmap-to-unicode
RUN bun install --frozen-lockfile
RUN bun audit
COPY --chown=bun:bun . .
COPY --from=history --chown=bun:bun /history.bundle /tmp/history.bundle
RUN git init && git fetch /tmp/history.bundle HEAD && git reset --mixed FETCH_HEAD && rm /tmp/history.bundle
# The context must be exactly HEAD under every path the later stages copy.
RUN test -z "$(git status --porcelain=v1 --untracked-files=all --ignored=matching -- src scripts package.json bun.lock)"
RUN bun run typecheck
RUN bun test --timeout 30000 tests/identity-login.test.ts tests/identity-proxy.test.ts tests/identity-ux.test.ts \
  tests/connection-consent.test.ts tests/account-handoff.test.ts tests/account-local-login.test.ts tests/profile.test.ts \
  tests/device-registry.test.ts tests/device-registry-capacity.test.ts tests/managed-transport.test.ts \
  tests/bridges.test.ts tests/bridges-api.test.ts tests/owner-panel-bridge.test.ts tests/owner-github.test.ts \
  tests/analytics-events.test.ts tests/brand-assets.test.ts tests/newsletter.test.ts
RUN git rev-parse HEAD > /tmp/qoopia-verify-passed

FROM ${BUN_IMAGE} AS build
WORKDIR /app
COPY package.json bun.lock ./
COPY scripts/vendor/transpect-fontmap-to-unicode ./scripts/vendor/transpect-fontmap-to-unicode
RUN bun install --frozen-lockfile --production
COPY src/identity ./src/identity
COPY src/analytics ./src/analytics
COPY src/bridges ./src/bridges
COPY src/brand.ts ./src/brand.ts
COPY src/utils/assets.ts ./src/utils/assets.ts
COPY src/utils/product-version.ts ./src/utils/product-version.ts
# Shared helpers the sign-in code imports (tests/identity-image.test.ts keeps this list complete).
COPY src/utils/fs.ts src/utils/html.ts src/utils/http-json.ts src/utils/cookies.ts ./src/utils/
COPY src/db/introspect.ts ./src/db/introspect.ts
COPY scripts/newsletter.ts ./scripts/newsletter.ts
RUN bun build src/identity/broker.ts --target=bun --outfile /broker.js
RUN bun build scripts/newsletter.ts --target=bun --outfile /newsletter.js

FROM ${BUN_IMAGE} AS runtime
ARG QOOPIA_GIT_SHA
WORKDIR /app
COPY --from=build /broker.js ./broker.js
COPY --from=build /newsletter.js ./newsletter.js
COPY --chown=1000:1000 src/public/brand ./assets/src/public/brand
# Keep the final stage dependent on verification. BuildKit may prune an
# unrelated stage even when it appears earlier in the Dockerfile.
COPY --from=verify /tmp/qoopia-verify-passed /tmp/qoopia-verify-passed
COPY --from=verify /app/scripts/release-stamp.ts /tmp/release-stamp.ts
# Stamp only the commit that verification actually checked; /health reports it.
RUN test "$(cat /tmp/qoopia-verify-passed)" = "${QOOPIA_GIT_SHA}"
RUN bun /tmp/release-stamp.ts --sha "${QOOPIA_GIT_SHA}" --output /app/release.json && rm /tmp/release-stamp.ts
ENV QOOPIA_RELEASE_STAMP_PATH=/app/release.json
# Replace every label inherited from the oven/bun base; release:build passes the values.
ARG QOOPIA_VERSION
ARG QOOPIA_CREATED
LABEL org.opencontainers.image.title="Qoopia sign-in" \
  org.opencontainers.image.description="Qoopia sign-in, account and bridge relay service" \
  org.opencontainers.image.url="https://qoopia.ai" \
  org.opencontainers.image.documentation="https://github.com/qoopia/qoopia-source" \
  org.opencontainers.image.source="https://github.com/qoopia/qoopia-source" \
  org.opencontainers.image.vendor="Qoopia" \
  org.opencontainers.image.licenses="MIT" \
  org.opencontainers.image.version="${QOOPIA_VERSION}" \
  org.opencontainers.image.created="${QOOPIA_CREATED}" \
  org.opencontainers.image.revision="${QOOPIA_GIT_SHA}"
ENV QOOPIA_BUNDLE_ASSETS=/app/assets
USER 1000:1000
# Verify the real service user can read assets even from a private build context.
RUN bun -e "const fs=require('node:fs');for(const file of fs.readdirSync('assets/src/public/brand',{recursive:true}))if(fs.statSync('assets/src/public/brand/'+file).isFile())fs.readFileSync('assets/src/public/brand/'+file)"
ENV QOOPIA_LOGIN_DB=/data/login.sqlite
CMD ["bun", "run", "broker.js"]
