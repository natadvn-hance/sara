# Profi-MCP: Chromium of the same version as the Playwright library in the code.
FROM mcr.microsoft.com/playwright:v1.64.1-noble
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN corepack enable
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile
CMD ["pnpm", "--filter", "@sara/profi-node", "exec", "tsx", "src/main.ts"]
