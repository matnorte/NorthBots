# NorthBot agent computer: a terminal and a web browser, nothing else.
FROM node:22-bookworm-slim AS node

FROM ubuntu:24.04
ENV DEBIAN_FRONTEND=noninteractive \
    PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright \
    LANG=C.UTF-8

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl git python3 python3-pip build-essential tini less nano jq unzip gocryptfs fuse3 \
  && rm -rf /var/lib/apt/lists/*

# Node 22 from the official image (same glibc family), no curl | bash installers.
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
 && ln -s /usr/local/lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx

# The agent's own unprivileged user. agentd runs as root and drops to this uid for shells.
RUN useradd --create-home --uid 1001 --shell /bin/bash agent

WORKDIR /opt/agentd
COPY docker/agent/agentd/package.json ./
RUN npm install --omit=dev --no-audit --no-fund \
 && npx playwright install --with-deps chromium \
 && rm -rf /root/.npm /var/lib/apt/lists/*
COPY docker/agent/agentd/*.mjs ./

RUN mkdir -p /run/agentd && chmod 700 /run/agentd
WORKDIR /home/agent
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "/opt/agentd/boot.mjs"]
