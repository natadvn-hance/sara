#!/bin/sh
# Forced command for the backup server's key on the main server (authorized_keys of user backup-pull).
# Only three requests: list the copies, give one copy, confirm a copy arrived (name and sha256).
set -eu
DIR=/var/backups/sara
set -- $SSH_ORIGINAL_COMMAND
case "${1:-}" in
  list) ls -1 "$DIR" | grep -E '^sara-[0-9TZ]+\.dump\.age$' ;;
  get)
    case "${2:-}" in sara-[0-9]*Z.dump.age) cat "$DIR/$2" ;; *) echo "bad name" >&2; exit 1 ;; esac ;;
  ack)
    case "${2:-}" in sara-[0-9]*Z.dump.age) echo "$(date -u +%FT%TZ) $2 ${3:-}" >> "$DIR/offsite-acks.log" ;; *) exit 1 ;; esac ;;
  *) echo "only list, get, ack" >&2; exit 1 ;;
esac
