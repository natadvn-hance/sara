#!/usr/bin/env bash
# On the backup server (cron, user sara-backup): fetch new copies from the main server, keep 30 days,
# and confirm each copy with its sha256 so the main server knows it is safe off site.
set -euo pipefail
MAIN="backup-pull@143.246.42.121"
cd /srv/sara-backups/wal
SSH="ssh -o BatchMode=yes -o ConnectTimeout=30 -i /srv/sara-backups/.ssh/pull $MAIN"
for f in $($SSH list); do
  [ -f "$f" ] && continue
  $SSH get "$f" > "$f.part" && mv "$f.part" "$f"
  $SSH ack "$f" "$(sha256sum "$f" | cut -d' ' -f1)"
done
find . -name 'sara-*.dump.age' -mtime +30 -delete
