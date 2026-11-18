# /mockup runtime image.
#
# A pinned Vite and its framework plugins, used as a library by server.mjs to serve a
# project's .mockup/ pages with hot module replacement. The project is bind-mounted
# read-only at /app and never installed into; Vite's cache goes to /tmp. The server starts as
# root and carries on as the owner of /app/.mockup, so the review store it writes there
# (stills/ and review/, mounted read-write) stays the host user's.

FROM node:22-alpine

WORKDIR /srv

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

COPY menu.mjs review.mjs review-cli.mjs server.mjs ./
COPY stills/ ./stills/

ENV APP_DIR=/app \
    PORT=80 \
    MOCKUP_CACHE_DIR=/tmp/vite

EXPOSE 80

CMD ["node", "/srv/server.mjs"]
