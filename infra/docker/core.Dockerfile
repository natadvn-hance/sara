# Core image: Node 24, the pinned Claude Code CLI and the TypeScript sources run with tsx.
FROM node:24-bookworm-slim
ARG CLAUDE_CODE_VERSION=2.1.308
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable && npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile
ENV SARA_ROLES_DIR=/app/roles SARA_DATA_DIR=/data
VOLUME ["/data"]
# node runs directly (not under pnpm), so SIGTERM reaches it and the core stops cleanly.
CMD ["node", "--import", "tsx", "apps/core/src/main.ts"]
