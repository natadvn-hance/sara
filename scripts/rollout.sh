#!/bin/sh
# Rolls the checked-out version out on the server one service at a time; scripts/deploy.sh starts it in /opt/sara.
#
# 07.11.2026 a deploy built every image at once: with the voice image the build needed about 10 GB on top of the
# running images, the 40 GB disk reached zero, Postgres stopped writing and Sara was down for half an hour. Here each
# service is built, started and its old image dropped before the next one is built, so the disk holds one new image
# at a time, and no build starts with less than NEED_GB free: the running containers stay as they are.
set -u
cd "$(dirname "$0")/.."
C="docker compose -f infra/compose.prod.yml --env-file .env"
# The biggest image (the Profi node, about 4.6 GB) and its build cache.
NEED_GB="${SARA_DEPLOY_NEED_GB:-7}"

free_gb() { df --output=avail -BG / | tail -1 | tr -dc 0-9; }
fail() { echo "$1"; echo DEPLOY-FAILED; exit 1; }

# Images no container runs (an earlier build that did not start) and old build cache go first.
docker image prune -af >/dev/null 2>&1
docker builder prune -f --keep-storage 2GB >/dev/null 2>&1
echo "Свободно на диске перед сборкой: $(free_gb) ГБ"

for s in $($C config --services); do
  free=$(free_gb)
  [ "$free" -ge "$NEED_GB" ] || fail "Мало места на диске: ${free} ГБ, нужно ${NEED_GB}. Выкладка остановлена перед ${s}: службы до неё уже на новой версии, ${s} и следующие работают на прошлой"
  echo "== ${s}"
  $C build "$s" || fail "Сборка ${s} не прошла, работающая версия ${s} не тронута"
  $C up -d --no-deps "$s" || fail "${s} не запустилась"
  # The old image of this service is now unused: dropped before the next build.
  docker image prune -f >/dev/null 2>&1
  docker builder prune -f --keep-storage 2GB >/dev/null 2>&1
done

$C up -d --remove-orphans || fail "Не все службы запустились"
echo "Свободно на диске после выкладки: $(free_gb) ГБ"
echo DEPLOY-OK
