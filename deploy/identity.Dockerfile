FROM oven/bun:1.3.11@sha256:0733e50325078969732ebe3b15ce4c4be5082f18c4ac1a0f0ca4839c2e4e42a7 AS build
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
COPY scripts/newsletter.ts ./scripts/newsletter.ts
RUN bun build src/identity/broker.ts --target=bun --outfile /broker.js
RUN bun build scripts/newsletter.ts --target=bun --outfile /newsletter.js

FROM oven/bun:1.3.11@sha256:0733e50325078969732ebe3b15ce4c4be5082f18c4ac1a0f0ca4839c2e4e42a7
WORKDIR /app
COPY --from=build /broker.js ./broker.js
COPY --from=build /newsletter.js ./newsletter.js
COPY --chown=1000:1000 src/public/brand ./assets/src/public/brand
ENV QOOPIA_BUNDLE_ASSETS=/app/assets
USER 1000:1000
# Verify the real service user can read assets even from a private build context.
RUN bun -e "const fs=require('node:fs');for(const file of fs.readdirSync('assets/src/public/brand',{recursive:true}))if(fs.statSync('assets/src/public/brand/'+file).isFile())fs.readFileSync('assets/src/public/brand/'+file)"
ENV QOOPIA_LOGIN_DB=/data/login.sqlite
CMD ["bun", "run", "broker.js"]
