#!/usr/bin/env bash
# pnpm staging <command>: the test stand on the server (docs/ops/staging.md). The work runs on the server
# (scripts/staging/server.sh); long steps run there in the background and this side only reads their log.
#   pnpm staging up [branch] [--reset] [--claude-from-prod] [--stand-ref <branch>]
#   pnpm staging reset [scenario]   pnpm staging scenario <name|file.json>   pnpm staging order [sample|real]
#   pnpm staging import-real   pnpm staging status   pnpm staging logs [service]   pnpm staging down
set -euo pipefail
HOST="${SARA_SERVER:-sara@143.246.42.121}"
DIR=/opt/sara-staging
SERVER="bash $DIR/stand/scripts/staging/server.sh"
# The link from the Mac loses packets: every call is retried a few times before giving up.
ssh_retry() {
  for _ in 1 2 3 4 5 6; do
    ssh -o BatchMode=yes -o ConnectTimeout=40 -o ServerAliveInterval=5 "$HOST" "$@" && return 0
    [ $? -ne 255 ] && return 1
    sleep 5
  done
  return 255
}

# A long step: started in the background on the server, followed by its log until it says how it ended.
long() {
  ssh_retry "nohup $SERVER $* > /tmp/staging.log 2>&1 &"
  echo "Идёт на сервере; ход: ssh $HOST tail -f /tmp/staging.log"
  until ssh_retry 'tail -1 /tmp/staging.log' 2>/dev/null | grep -qE 'STAGING-(OK|FAILED)'; do sleep 15; done
  if ssh_retry "grep '^\[стенд\]' /tmp/staging.log; tail -1 /tmp/staging.log" | tee /dev/stderr | grep -q STAGING-OK; then
    return 0
  fi
  echo "Не вышло; весь лог: ssh $HOST cat /tmp/staging.log"
  return 1
}

cmd="${1:-status}"
shift || true
case "$cmd" in
  up)
    stand_ref=main
    args=()
    while [ $# -gt 0 ]; do
      if [ "$1" = --stand-ref ]; then stand_ref="${2:?после --stand-ref нужна ветка}"; shift 2; else args+=("$1"); shift; fi
    done
    # The stand's own checkout first, in a call of its own: the script that runs next must not change under its feet.
    ssh_retry "sudo mkdir -p $DIR /opt/sara-sites && sudo chown sara:sara $DIR /opt/sara-sites
      if [ ! -d $DIR/stand/.git ]; then
        git clone -q /opt/sara $DIR/stand && git -C $DIR/stand remote set-url origin \"\$(git -C /opt/sara remote get-url origin)\"
      fi
      git -C $DIR/stand fetch -q origin && git -C $DIR/stand checkout -q -f --detach origin/$stand_ref
      echo \"Стенд из \$(git -C $DIR/stand log --oneline -1)\""
    long up "${args[@]+"${args[@]}"}"
    ;;
  reset) long reset "$@" ;;
  scenario)
    what="${1:?Укажи сценарий: имя из apps/profi-node/src/stand/scenarios или файл .json}"
    if [ -f "$what" ]; then ssh_retry "$SERVER scenario -" < "$what"; else ssh_retry "$SERVER scenario $what"; fi
    ;;
  order | import-real | status | logs | mirror | down) ssh_retry "$SERVER $cmd $*" ;;
  *)
    echo "Команды: up [ветка] [--reset] [--claude-from-prod] [--stand-ref ветка] | reset [сценарий] | scenario <имя|файл> | order [sample|real] | import-real | status | logs [служба] | down"
    exit 1
    ;;
esac
