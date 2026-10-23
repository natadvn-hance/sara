#!/usr/bin/env bash
# Nightly encrypted copy of the database (cron, root, main server). The backup server in Saint Petersburg
# pulls it from here (pull.sh): connections from abroad into it do not pass, its own connections out do.
set -euo pipefail
cd /opt/sara
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
DIR=/var/backups/sara
FILE="${DIR}/sara-${STAMP}.dump.age"
install -d -m 750 -g backup-pull "$DIR"
docker compose -f infra/compose.prod.yml --env-file .env exec -T postgres \
  pg_dump -U sara -d sara -Fc --no-owner \
  | age -r "$(cat /etc/sara/backup.pub)" > "${FILE}.part"
mv "${FILE}.part" "$FILE"
chgrp backup-pull "$FILE"
chmod 640 "$FILE"
find "$DIR" -name 'sara-*.dump.age' -mtime +3 -delete
echo "$(date -u +%FT%TZ) dump $(basename "$FILE") $(stat -c %s "$FILE") bytes" >> /var/log/sara-backup.log
