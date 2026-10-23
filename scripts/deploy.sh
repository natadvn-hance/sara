#!/usr/bin/env bash
# Deploys main to the server: pnpm deploy <ssh-host>. Builds on the server (one server, ADR-021).
set -euo pipefail
HOST="${1:?Укажи сервер: pnpm deploy sara@<адрес>}"
ssh "$HOST" 'set -e
  cd /opt/sara
  git fetch -q origin && git checkout -q origin/main
  sops -d .env.sops > .env
  docker compose -f infra/compose.prod.yml --env-file .env build
  docker compose -f infra/compose.prod.yml --env-file .env up -d
  docker compose -f infra/compose.prod.yml ps'
DOMAIN=$(ssh "$HOST" 'grep ^SARA_DOMAIN= /opt/sara/.env | cut -d= -f2')
code=$(curl -s -o /dev/null -w '%{http_code}' "https://${DOMAIN}/api/setup")
[ "$code" = 200 ] && echo "Выложено: https://${DOMAIN}" || { echo "Пульт не ответил (код $code)"; exit 1; }
