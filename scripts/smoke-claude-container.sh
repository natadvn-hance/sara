#!/usr/bin/env bash
# Assumption A1: `claude -p` on the subscription works inside the core container.
# Needs the Claude token saved by the setup wizard (.sara/secrets.json) and the dev database running.
set -euo pipefail
cd "$(dirname "$0")/.."
TOKEN=$(node -e "const s=require('./.sara/secrets.json'); if(!s.claude_oauth_token){process.exit(1)}; console.log(s.claude_oauth_token)") || {
  echo "Нет токена Claude: пройди шаг Claude в мастере запуска."; exit 1; }
docker build -f infra/docker/core.Dockerfile -t sara-core:smoke .
docker run --rm --add-host=host.docker.internal:host-gateway \
  -e CLAUDE_CODE_OAUTH_TOKEN="$TOKEN" \
  -e DATABASE_URL=postgres://sara:sara@host.docker.internal:54329/sara \
  sara-core:smoke pnpm --filter @sara/core exec tsx src/gateway/probeCli.ts
