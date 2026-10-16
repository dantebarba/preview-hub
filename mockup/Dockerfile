# /mockup runtime image.
#
# A pinned Vite and its framework plugins, used as a library by server.mjs to serve a
# project's .mockup/ pages with hot module replacement. The project is bind-mounted
# read-only at /app and never installed into; Vite's cache goes to /tmp.

FROM node:22-alpine

WORKDIR /srv

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

COPY menu.mjs server.mjs ./

ENV APP_DIR=/app \
    PORT=80 \
    MOCKUP_CACHE_DIR=/tmp/vite

EXPOSE 80

CMD ["node", "/srv/server.mjs"]
