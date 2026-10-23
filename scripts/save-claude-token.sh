#!/usr/bin/env bash
# Saves the Claude token from the clipboard into .sara/secrets.json and runs one probe call.
# The token value is never printed.
set -euo pipefail
cd "$(dirname "$0")/.."
TOKEN=$(pbpaste | tr -d '[:space:]')
case "$TOKEN" in
  sk-ant-oat*) ;;
  *) echo "В буфере обмена нет токена Claude (он начинается с sk-ant-oat). Скопируй его из терминала и повтори."; exit 1 ;;
esac
CLAUDE_CODE_OAUTH_TOKEN="$TOKEN" pnpm -s --filter @sara/core exec tsx src/gateway/probeCli.ts 2>&1 | grep -v -i deprecation
