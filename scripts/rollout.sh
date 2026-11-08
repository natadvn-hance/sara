#!/bin/sh
# Rolls the checked-out version out on the server one service at a time; scripts/deploy.sh starts it in /opt/sara and
# passes the commit the server stood on before (`sh scripts/rollout.sh <old commit>`).
#
# 07.11.2026 a deploy built every image at once: with the voice image the build needed about 10 GB on top of the
# running images, the 40 GB disk reached zero, Postgres stopped writing and Sara was down for half an hour. Here each
# service is built, started and its old image dropped before the next one is built, and no build starts with less free
# disk than that service needs: the running containers stay as they are.
#
# 08.11.2026 the disk had room for one image at a time but every deploy rebuilt all five from scratch: now a service is
# built only when a file it is made of changed since the commit it was last built from (kept in ~/.sara-deployed, the
# old commit for a service never recorded). Unknown paths count as changed.
set -u
cd "$(dirname "$0")/.."
C="docker compose -f infra/compose.prod.yml --env-file .env"
OLD="${1:-}"
STATE="${SARA_DEPLOY_STATE:-$HOME/.sara-deployed}"
HEAD=$(git rev-parse HEAD)
mkdir -p "$STATE"

free_gb() { df --output=avail -BG / | tail -1 | tr -dc 0-9; }
fail() { echo "$1"; echo DEPLOY-FAILED; exit 1; }

# GB free a build needs: the image, its build cache and a margin for Postgres.
need_gb() {
  case "$1" in
    profi-node) echo 7 ;;
    core) echo 5 ;;
    voice) echo 4 ;;
    caddy) echo 3 ;;
    *) echo 1 ;;
  esac
}

# Files no image is made of, then the ones each service leaves to the others.
COMMON='^(docs/|tests/|\.github/|\.claude/|[^/]+\.md$|\.release-please|release-please-config\.json|commitlint\.config|biome\.json|\.gitleaks|\.gitignore|infra/compose\.prod\.yml|infra/backup/|infra/env\.prod\.example|scripts/(deploy|rollout)\.sh)'
others() {
  case "$1" in
    core) echo '^(apps/web/|apps/site/|infra/voice/|infra/caddy/|infra/docker/(web|voice|socks|profi-node)\.Dockerfile)' ;;
    caddy) echo '^(apps/core/|apps/profi-node/|apps/site/|infra/voice/|roles/|scripts/|infra/docker/(core|voice|socks|profi-node)\.Dockerfile)' ;;
    profi-node) echo '^(apps/core/|apps/web/|apps/site/|infra/voice/|infra/caddy/|roles/|scripts/|infra/docker/(core|web|voice|socks)\.Dockerfile)' ;;
    *) echo '^$' ;;
  esac
}
# The voice and the socks image are made of their own files only.
own() {
  case "$1" in
    voice) echo '^(infra/voice/|infra/docker/voice\.Dockerfile)' ;;
    socks-ip1) echo '^infra/docker/socks\.Dockerfile' ;;
    *) echo '' ;;
  esac
}

# Whether the service has to be built: no record of what it runs, or a file of its own changed since then.
changed() {
  base=$(cat "$STATE/$1" 2>/dev/null || echo "$OLD")
  [ -n "$base" ] && git cat-file -e "${base}^{commit}" 2>/dev/null || return 0
  [ -n "$($C ps -q "$1" 2>/dev/null)" ] || return 0
  files=$(git diff --name-only "$base" "$HEAD")
  mine=$(own "$1")
  if [ -n "$mine" ]; then
    echo "$files" | grep -qE "$mine"
  else
    [ -n "$(echo "$files" | grep -vE "$COMMON" | grep -vE "$(others "$1")" | grep -v '^$')" ]
  fi
}

# Images no container runs (an earlier build that did not start) and old build cache go first.
docker image prune -af >/dev/null 2>&1
docker builder prune -f --keep-storage 2GB >/dev/null 2>&1
echo "Свободно на диске перед сборкой: $(free_gb) ГБ"

for s in $($C config --services); do
  # The database is an image of its own, never built here.
  [ "$s" = postgres ] && continue
  if ! changed "$s"; then
    echo "== ${s}: без изменений, не собираю"
    echo "$HEAD" > "$STATE/$s"
    continue
  fi
  need=$(need_gb "$s")
  # The voice can wait: short of room, it stops and drops its image before its build, never Sara or the base.
  if [ "$(free_gb)" -lt "$need" ] && [ "$s" = voice ]; then
    echo "== voice: мало места, останавливаю голос на время сборки"
    $C stop voice >/dev/null 2>&1; $C rm -f voice >/dev/null 2>&1
    docker image prune -af >/dev/null 2>&1; docker builder prune -af >/dev/null 2>&1
  fi
  free=$(free_gb)
  [ "$free" -ge "$need" ] || fail "Мало места на диске: ${free} ГБ, для ${s} нужно ${need}. Выкладка остановлена перед ${s}: службы до неё уже на новой версии, ${s} и следующие работают на прошлой"
  echo "== ${s} (свободно ${free} ГБ)"
  $C build "$s" || fail "Сборка ${s} не прошла, работающая версия ${s} не тронута"
  $C up -d --no-deps "$s" || fail "${s} не запустилась"
  echo "$HEAD" > "$STATE/$s"
  # The old image of this service is now unused: dropped before the next build.
  docker image prune -f >/dev/null 2>&1
  docker builder prune -f --keep-storage 2GB >/dev/null 2>&1
done

$C up -d --remove-orphans || fail "Не все службы запустились"
echo "Свободно на диске после выкладки: $(free_gb) ГБ"
echo DEPLOY-OK
