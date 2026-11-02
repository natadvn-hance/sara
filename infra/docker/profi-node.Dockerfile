# Profi-MCP: Chromium of the same version as the Playwright library in the code.
FROM mcr.microsoft.com/playwright:v1.64.1-noble
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
# The image's tag moved to Node 26, which ships no corepack (seen 02.11.2026). The code and CI run on Node 24, so here too.
ARG NODE_VERSION=24.22.1
RUN arch="$(dpkg --print-architecture | sed s/amd64/x64/)" \
  && curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${arch}.tar.gz" \
  | tar -xz -C /usr/local --strip-components=1
RUN corepack enable
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile
# node runs directly (not under pnpm), so SIGTERM reaches it and the browsers close cleanly.
CMD ["node", "--import", "tsx", "apps/profi-node/src/main.ts"]
