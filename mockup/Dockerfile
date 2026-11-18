# /mockup runtime image.
#
# A pinned Vite and its framework plugins, used as a library by server.mjs to serve a
# project's .mockup/ pages with hot module replacement. The project is bind-mounted
# read-only at /app and never installed into; Vite's cache goes to /tmp. The server starts as
# root and carries on as the owner of /app/.mockup, so the review store it writes there
# (stills/ and review/, mounted read-write) stays the host user's.
#
# Chromium and the Noto fonts (with emoji) are here too, for capture.mjs: `mockup.sh shot` and
# `preview stills shoot` run it in the mockup's own container to shoot its pages as devices
# through the DevTools protocol, so one pinned image serves, reviews and shoots.
#
# With STILLS_DIR set, server.mjs serves that directory of images for review instead, with no
# project mounted: `preview stills serve` runs it as the calling user on the folder at /stills.

FROM node:22-alpine

RUN apk add --no-cache chromium font-noto font-noto-emoji

WORKDIR /srv

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

COPY capture.mjs export.mjs folder.mjs menu.mjs review.mjs review-cli.mjs server.mjs ./
COPY stills/ ./stills/
COPY vendor/ ./vendor/
COPY extras.mjs source.mjs ./

ENV APP_DIR=/app \
    PORT=80 \
    MOCKUP_CACHE_DIR=/tmp/vite

EXPOSE 80

CMD ["node", "/srv/server.mjs"]
