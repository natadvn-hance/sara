#!/usr/bin/env bash
# The test stand on the server (docs/ops/staging.md), run from its own checkout /opt/sara-staging/stand.
# pnpm staging on the Mac calls it over ssh; the live Sara is only read: its database (read only), its mind (a copy).
#   up [branch] [--reset] [--claude-from-prod]   reset [scenario]   mirror   import-real
#   order [sample|real][:n]   scenario <name|->   status   logs [service]   down
set -euo pipefail

# The places below can be overridden for a rehearsal on the Mac (a stand beside a made-up «live» database).
STAGING_DIR="${STAGING_DIR:-/opt/sara-staging}"
APP="$STAGING_DIR/app"
STAND="$(cd "$(dirname "$0")/../.." && pwd)"
ENV_FILE="$STAGING_DIR/.env"
SITES="${STAGING_SITES:-/opt/sara-sites}"
LIVE_REPO="${LIVE_REPO:-/opt/sara}"
LIVE_MIND="${LIVE_MIND:-/opt/sara-mind}"
LIVE_ENV="$LIVE_REPO/.env"
LIVE_PG="${LIVE_PG:-sara-postgres-1}"
LIVE_CORE="${LIVE_CORE:-sara-core-1}"
LIVE_CADDY="${LIVE_CADDY:-sara-caddy-1}"
export STAGING_DIR STAGING_APP_DIR="$APP"

say() { echo "[стенд] $*"; }
compose() { docker compose -f "$STAND/infra/compose.staging.yml" --env-file "$ENV_FILE" "$@"; }
stand_cli() { compose exec -T stand node --import tsx apps/profi-node/src/stand/cli.ts "$@"; }
psql_stand() { compose exec -T postgres psql -U sara -d sara -v ON_ERROR_STOP=1 -q "$@"; }
# Every read of the live database runs in a read-only transaction.
psql_live() { docker exec -i -e PGOPTIONS='-c default_transaction_read_only=on' "$LIVE_PG" psql -U sara -d sara -v ON_ERROR_STOP=1 -At "$@"; }
domain() { grep '^STAGING_DOMAIN=' "$ENV_FILE" | cut -d= -f2; }

ensure_env() {
  [ -f "$ENV_FILE" ] && return
  umask 077
  cat > "$ENV_FILE" <<EOF
# The test stand's own secrets (docs/ops/staging.md), made on the server, never in git.
STAGING_DOMAIN=test.sara.hance.pro
POSTGRES_PASSWORD=$(openssl rand -hex 24)
SARA_NODE_TOKEN=$(openssl rand -hex 24)
SARA_PERMIT_SECRET=$(openssl rand -hex 32)
STAND_CLIENT_DAILY_LIMIT=40
EOF
  say "Сделала $ENV_FILE с новыми паролями (права 600)"
}

wait_core() {
  for _ in $(seq 1 60); do
    compose exec -T core node -e "fetch('http://127.0.0.1:3300/api/setup').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))" 2>/dev/null && return 0
    sleep 3
  done
  say "Ядро стенда не ответило за 3 минуты: pnpm staging logs core"
  return 1
}

wait_stand() {
  for _ in $(seq 1 30); do
    stand_cli status >/dev/null 2>&1 && return 0
    sleep 2
  done
  say "Профи.ру понарошку не ответил: pnpm staging logs stand"
  return 1
}

# The live settings, rules and profile, then what the stand changes in them: bids and messages go (made up, free),
# no night school (the Claude limit is shared), no quiet hours, high day limits.
mirror() {
  local tmp
  tmp=$(mktemp -d)
  docker exec "$LIVE_PG" pg_dump -U sara -d sara --data-only --column-inserts \
    -t core.direction_version -t core.direction_profile > "$tmp/config.sql"
  psql_live -c "copy (select key, value, changed_by, changed_at from core.setting where key not like 'setup.%') to stdout" > "$tmp/settings.tsv"
  {
    echo "begin;"
    echo "delete from core.direction_version; delete from core.direction_profile;"
    echo "delete from core.setting where key not like 'setup.%';"
    grep -v '^SET \|^SELECT pg_catalog' "$tmp/config.sql"
    echo "copy core.setting (key, value, changed_by, changed_at) from stdin;"
    cat "$tmp/settings.tsv"
    echo '\.'
    cat <<'SQL'
insert into core.setting (key, value, changed_by) values
  ('outbound.bids', 'true', 'boris'), ('outbound.messages', 'true', 'boris'),
  ('pipeline.leads', 'true', 'boris'), ('pipeline.conversations', 'true', 'boris'),
  ('conv.v1_writes', 'false', 'boris'), ('school.on', 'false', 'boris'),
  ('cards.quiet_hours', 'null', 'boris'), ('money.daily_bids', '100', 'boris'),
  ('money.daily_budget_rub', 'null', 'boris'), ('money.max_fee_rub', 'null', 'boris'),
  ('cards.max_per_day', '100', 'boris'), ('conv.cards_per_day', '100', 'boris')
on conflict (key) do update set value = excluded.value, changed_by = excluded.changed_by, changed_at = now();
commit;
SQL
  } | psql_stand
  rm -rf "$tmp"
  say "Настройки, правила и профиль скопированы с боя, отклики и сообщения на стенде включены"
}

# The last 300 live orders and the trainer's personas, read only; the stand keeps them with made-up names.
import_real() {
  psql_live <<'SQL' | stand_cli import
select json_build_object('lead', json_build_object('id', id, 'title', title, 'category', category, 'city', city,
  'text', text, 'client_name', client_name, 'budget_text', budget_text, 'bid_price_rub', bid_price_rub,
  'client_info', client_info))
from (select * from core.lead order by seen_at desc limit 300) l;
select json_build_object('persona', json_build_object('id', id, 'archetype', archetype, 'niche', niche, 'task', task,
  'mood', mood, 'style', style, 'questions', questions))
from core.persona where active;
SQL
}

# Wipes the stand's database, its durable processes and the made-up site; keeps the pult password, the bot binding,
# the wizard's steps and secrets.json, so the wizard is not done again.
reset_db() {
  local keep="$STAGING_DIR/keep"
  mkdir -p -m 700 "$keep"
  compose exec -T postgres pg_dump -U sara -d sara --data-only -t core.owner_auth > "$keep/owner_auth.sql" 2>/dev/null || : > "$keep/owner_auth.sql"
  psql_stand -At -c "copy (select key, value, changed_by, changed_at from core.setting where key like 'setup.%') to stdout" > "$keep/setup.tsv" 2>/dev/null || : > "$keep/setup.tsv"
  compose stop core stand
  compose exec -T postgres psql -U sara -d postgres -v ON_ERROR_STOP=1 -q \
    -c "drop database if exists sara with (force)" -c "drop database if exists sara_dbos_sys with (force)" \
    -c "create database sara"
  compose run --rm --no-deps -T stand rm -f /stand-data/state.json
  compose run --rm --no-deps -T core node --import tsx apps/core/src/db/migrate.ts
  grep -v '^SET \|^SELECT pg_catalog' "$keep/owner_auth.sql" | psql_stand
  { echo "copy core.setting (key, value, changed_by, changed_at) from stdin;"; cat "$keep/setup.tsv"; echo '\.'; } | psql_stand
  mirror
  compose up -d core stand
  wait_core
  say "Стенд стёрт: база, процессы и Профи.ру понарошку с нуля; пароль, бот и токены на месте"
}

# The live Caddy serves the stand's address once its DNS points here and the live deploy has the extra sites folder.
front_on() {
  local d ip live
  d=$(domain)
  ip=$(getent ahostsv4 "$d" | awk 'NR==1{print $1}' || true)
  live=$(getent ahostsv4 "$(grep '^SARA_DOMAIN=' "$LIVE_ENV" | cut -d= -f2)" | awk 'NR==1{print $1}' || true)
  if [ -z "$ip" ] || [ "$ip" != "$live" ]; then
    say "Адрес $d ещё не ведёт на сервер (DNS: ${ip:-нет записи}): пульт стенда пока не открыть снаружи"
    return 0
  fi
  if ! docker inspect "$LIVE_CADDY" --format '{{range .Mounts}}{{.Destination}} {{end}}' | grep -q /etc/caddy/sites; then
    say "Caddy боевой Сары ещё без папки адресов: выложи боевую Сару с этой правкой (pnpm deploy)"
    return 0
  fi
  printf '%s {\n\tencode zstd gzip\n\treverse_proxy sara-staging-web:80\n}\n' "$d" > "$SITES/staging.caddy"
  docker exec "$LIVE_CADDY" caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile
  say "Пульт стенда: https://$d, Профи.ру понарошку: https://$d/stand/"
}

front_off() {
  rm -f "$SITES/staging.caddy"
  docker exec "$LIVE_CADDY" caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile || true
}

# The live core's Claude token into the stand core's secrets.json, inside the server only (the same subscription).
claude_from_live() {
  docker exec "$LIVE_CORE" cat /data/secrets.json | compose exec -T core node -e '
    const fs = require("node:fs")
    const live = JSON.parse(fs.readFileSync(0, "utf8")).claude_oauth_token
    if (!live) { console.error("У боевого ядра нет токена Claude"); process.exit(1) }
    const file = "/data/secrets.json"
    const own = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {}
    fs.mkdirSync("/data", { recursive: true, mode: 0o700 })
    fs.writeFileSync(file + ".tmp", JSON.stringify({ ...own, claude_oauth_token: live }, null, 2), { mode: 0o600 })
    fs.renameSync(file + ".tmp", file)'
  say "Токен Claude боевого ядра скопирован в ядро стенда (внутри сервера)"
}

up() {
  local branch=main reset=0 claude=0
  for a in "$@"; do
    case "$a" in
      --reset) reset=1 ;;
      --claude-from-prod) claude=1 ;;
      -*) say "Не знаю ключ $a"; return 1 ;;
      *) branch="$a" ;;
    esac
  done
  docker network inspect sara-stage-link >/dev/null 2>&1 || {
    say "Нет сети sara-stage-link: сначала выложи боевую Сару с правкой Caddy (pnpm deploy)"
    return 1
  }
  ensure_env
  if [ ! -d "$APP/.git" ]; then
    git clone -q "$LIVE_REPO" "$APP"
    git -C "$APP" remote set-url origin "$(git -C "$LIVE_REPO" remote get-url origin)"
  fi
  git -C "$APP" fetch -q origin
  git -C "$APP" checkout -q -f --detach "origin/$branch"
  git -C "$APP" clean -fdq
  local overlay=no
  # A branch from before the stand gets the stand's Profi.ru from its own checkout; its core and pult stay its own.
  if [ ! -d "$APP/apps/profi-node/src/stand" ]; then
    cp -R "$STAND/apps/profi-node/src/stand" "$APP/apps/profi-node/src/"
    cp "$STAND/apps/profi-node/src/fake/fakeProfi.ts" "$APP/apps/profi-node/src/fake/fakeProfi.ts"
    overlay=yes
  fi
  if [ -d "$LIVE_MIND/.git" ]; then
    if [ -d "$STAGING_DIR/mind/.git" ]; then git -C "$STAGING_DIR/mind" pull -q --ff-only; else git clone -q "$LIVE_MIND" "$STAGING_DIR/mind"; fi
  else
    mkdir -p "$STAGING_DIR/mind"
  fi
  # Migrations a branch does not have but the database already ran: the schema would not match, start over.
  local now_migrations="$STAGING_DIR/migrations.now" ran="$STAGING_DIR/migrations.txt"
  ls "$APP/apps/core/drizzle" | grep '\.sql$' | sort > "$now_migrations"
  if [ -f "$ran" ] && [ -n "$(comm -23 "$ran" "$now_migrations")" ] && [ "$reset" = 0 ]; then
    say "В базе стенда есть миграции, которых нет в ветке $branch:"
    comm -23 "$ran" "$now_migrations"
    say "Запусти с --reset, чтобы начать с чистой базы"
    return 1
  fi
  say "Собираю ветку $branch ($(git -C "$APP" log --oneline -1)), Профи.ру понарошку подложен: $overlay"
  compose build core web
  docker image prune -f --filter label=com.docker.compose.project=sara-staging >/dev/null
  compose up -d --remove-orphans
  wait_core
  if [ "$reset" = 1 ]; then
    reset_db
  elif [ ! -f "$STAGING_DIR/.mirrored" ]; then
    mirror
    compose restart core
    wait_core
  fi
  touch "$STAGING_DIR/.mirrored"
  mv "$now_migrations" "$ran"
  [ "$claude" = 1 ] && claude_from_live
  wait_stand
  if [ ! -s "$STAGING_DIR/.imported" ]; then
    import_real && date -u +%FT%TZ > "$STAGING_DIR/.imported" || say "Копии реальных заказов не сделаны: pnpm staging import-real"
  fi
  front_on
  printf 'branch=%s\ncommit=%s\noverlay=%s\nat=%s\n' "$branch" "$(git -C "$APP" rev-parse --short HEAD)" "$overlay" "$(date -u +%FT%TZ)" > "$STAGING_DIR/deployed"
}

status() {
  [ -f "$STAGING_DIR/deployed" ] && sed 's/^/  /' "$STAGING_DIR/deployed" || say "Стенд ещё не поднимали"
  compose ps --format '{{.Service}} {{.State}}' 2>/dev/null || true
  stand_cli status 2>/dev/null || say "Профи.ру понарошку не отвечает"
  local ids
  ids=$(compose ps -q 2>/dev/null || true)
  [ -n "$ids" ] && docker stats --no-stream --format '{{.Name}} {{.MemUsage}}' $ids

  df -h / | tail -1 | awk '{print "Диск сервера: занято " $3 " из " $2 ", свободно " $4}'
}

cmd="${1:-status}"
shift || true
case "$cmd" in
  up)
    trap 'echo STAGING-FAILED' ERR
    up "$@"
    echo STAGING-OK
    ;;
  reset)
    trap 'echo STAGING-FAILED' ERR
    reset_db
    wait_stand
    [ -n "${1:-}" ] && stand_cli scenario "$1"
    echo STAGING-OK
    ;;
  mirror) mirror && compose restart core ;;
  import-real) import_real && date -u +%FT%TZ > "$STAGING_DIR/.imported" ;;
  order) stand_cli order "${1:-real}" ;;
  scenario) stand_cli scenario "${1:--}" ;;
  status) status ;;
  logs) compose logs --tail "${2:-100}" "${1:-core}" ;;
  down)
    front_off
    compose down
    say "Стенд остановлен, его данные сохранены; адрес убран из Caddy"
    ;;
  *)
    echo "Команды: up [ветка] [--reset] [--claude-from-prod] | reset [сценарий] | mirror | import-real | order | scenario | status | logs | down"
    exit 1
    ;;
esac
