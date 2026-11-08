#!/usr/bin/env bash
# Deploys main to the server: pnpm deploy sara@<address>. The server builds the images itself from GitHub,
# so only short commands cross the slow link from the Mac (ADR-021). They are built and started one service at a time
# with a check of the free disk before each, and only the ones whose files changed (scripts/rollout.sh, 07-08.11.2026).
set -euo pipefail
HOST="${1:?Укажи сервер: pnpm deploy sara@<адрес>}"
# The link from the Mac loses packets: every call is retried a few times before giving up.
SSH=ssh_retry
ssh_retry() {
  for i in 1 2 3 4 5 6; do
    ssh -o BatchMode=yes -o ConnectTimeout=40 -o ServerAliveInterval=5 "$HOST" "$@" && return 0
    [ $? -ne 255 ] && return 1
    sleep 5
  done
  return 255
}
$SSH 'cd /opt/sara && old=$(git rev-parse HEAD) && git fetch -q origin && git checkout -q --detach origin/main && git log --oneline -1
  if [ -d /opt/sara-mind/.git ]; then git -C /opt/sara-mind pull -q --ff-only && git -C /opt/sara-mind log --oneline -1; else echo "Разума на сервере нет: RB-17"; fi
  nohup sh scripts/rollout.sh "$old" > /tmp/deploy.log 2>&1 &'
echo "Сборка идёт на сервере; ход: ssh $HOST tail -f /tmp/deploy.log"
until $SSH 'tail -1 /tmp/deploy.log' 2>/dev/null | grep -qE 'DEPLOY-(OK|FAILED)'; do sleep 20; done
$SSH 'tail -3 /tmp/deploy.log; docker compose -f /opt/sara/infra/compose.prod.yml --env-file /opt/sara/.env ps --format "{{.Service}} {{.State}}"'
DOMAIN=$($SSH 'grep ^SARA_DOMAIN= /opt/sara/.env | cut -d= -f2')
code=$(curl -s -o /dev/null -w '%{http_code}' "https://${DOMAIN}/api/setup")
[ "$code" = 200 ] && echo "Выложено: https://${DOMAIN}" || { echo "Пульт не ответил (код $code)"; exit 1; }
