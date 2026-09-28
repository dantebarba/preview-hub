# Preview Hub backend image.
#
# Runs the bun HTTP server that discovers previews from the Docker socket and
# serves the PWA. There are no build-time secrets; beyond the pinned base image it
# installs only openssh-client, which sharing uses to reach the edge host — the
# server ships with no third-party deps.

FROM oven/bun:1.2-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends openssh-client \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY *.js ./
COPY public ./public

ENV HUB_PORT=8788

EXPOSE 8788

CMD ["bun", "server.js"]
