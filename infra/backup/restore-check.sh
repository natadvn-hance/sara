#!/usr/bin/env bash
# Weekly restore drill (SLO-7), root on the main server: the newest copy is restored into a scratch database
# and must match the sha256 the backup server confirmed for its off-site copy.
set -euo pipefail
cd /opt/sara
START=$(date +%s)
DIR=/var/backups/sara
LATEST=$(ls -1t "$DIR"/sara-*.dump.age | head -1)
NAME=$(basename "$LATEST")
SHA=$(sha256sum "$LATEST" | cut -d' ' -f1)
grep -q " $NAME $SHA\$" "$DIR/offsite-acks.log" || { echo "копии $NAME нет на сервере копий или она другая"; exit 1; }
age -d -i /etc/sara/backup.key "$LATEST" > /tmp/restore.dump
DC="docker compose -f infra/compose.prod.yml --env-file .env"
$DC exec -T postgres psql -U sara -d postgres -c 'drop database if exists restore_check' -c 'create database restore_check' >/dev/null
$DC exec -T postgres pg_restore -U sara -d restore_check --no-owner < /tmp/restore.dump
EVENTS=$($DC exec -T postgres psql -U sara -d restore_check -tAc 'select count(*) from core.event')
$DC exec -T postgres psql -U sara -d postgres -c 'drop database restore_check' >/dev/null
rm -f /tmp/restore.dump
echo "$(date -u +%FT%TZ) restore ok: ${NAME}, events ${EVENTS}, same as off site, $(( $(date +%s) - START )) s" | tee -a /var/log/sara-backup.log
