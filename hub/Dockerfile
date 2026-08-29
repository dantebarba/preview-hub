# Preview Hub backend image.
#
# Runs the bun HTTP server that discovers previews from the Docker socket and
# serves the PWA. There are no build-time secrets and no network fetches beyond
# pulling the pinned base image — the server ships with no third-party deps.

FROM oven/bun:1.2-slim

WORKDIR /app

COPY *.js ./
COPY public ./public

ENV HUB_PORT=8788

EXPOSE 8788

CMD ["bun", "server.js"]
