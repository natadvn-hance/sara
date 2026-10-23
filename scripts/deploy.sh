#!/usr/bin/env bash
# Deploys main to the server: pnpm deploy sara@<address>. The server builds the images itself from GitHub,
# so only short commands cross the slow link from the Mac (ADR-021).
set -euo pipefail
HOST="${1:?Укажи сервер: pnpm deploy sara@<адрес>}"
SSH="ssh -o BatchMode=yes -o ConnectTimeout=40 -o ServerAliveInterval=5 $HOST"
$SSH 'cd /opt/sara && git fetch -q origin && git checkout -q --detach origin/main && git log --oneline -1
  nohup sh -c "docker compose -f infra/compose.prod.yml --env-file .env up -d --build --remove-orphans && echo DEPLOY-OK || echo DEPLOY-FAILED" > /tmp/deploy.log 2>&1 &'
echo "Сборка идёт на сервере; ход: ssh $HOST tail -f /tmp/deploy.log"
until $SSH 'tail -1 /tmp/deploy.log' 2>/dev/null | grep -qE 'DEPLOY-(OK|FAILED)'; do sleep 20; done
$SSH 'tail -3 /tmp/deploy.log; docker compose -f /opt/sara/infra/compose.prod.yml --env-file /opt/sara/.env ps --format "{{.Service}} {{.State}}"'
DOMAIN=$($SSH 'grep ^SARA_DOMAIN= /opt/sara/.env | cut -d= -f2')
code=$(curl -s -o /dev/null -w '%{http_code}' "https://${DOMAIN}/api/setup")
[ "$code" = 200 ] && echo "Выложено: https://${DOMAIN}" || { echo "Пульт не ответил (код $code)"; exit 1; }
