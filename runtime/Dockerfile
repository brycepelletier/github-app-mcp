FROM node:24.19.0-bookworm-slim

ARG DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates git \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/github-app-mcp
COPY package.json npm-shrinkwrap.json ./
RUN npm ci --omit=dev --ignore-scripts \
    && npm cache clean --force

COPY runtime/git-helper.mjs ./git-helper.mjs
RUN useradd --create-home --shell /usr/sbin/nologin github-app \
    && mkdir -p /tmp/github-app-mcp \
    && chown github-app:github-app /tmp/github-app-mcp \
    && chmod 0555 ./git-helper.mjs

USER github-app
ENTRYPOINT ["node", "/opt/github-app-mcp/git-helper.mjs"]
