# M0 «Фундамент и сквозной путь»: план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** На Маке одной командой поднимается система; фальшивая заявка проходит путь «журнал → Сортировщик (настоящий `claude -p`) → карточка в Telegram → «да» → исходящая очередь → фальшивый отклик → журнал», и это проверено тестами и чек-листом приёмки.

**Architecture:** pnpm-монорепозиторий на TypeScript: `packages/shared` (контракты на zod, ADR-014), `apps/core` (Fastify, Drizzle, DBOS, grammY, шлюз Claude), `apps/profi-node` (MCP-сервер; в M0 только фальшивый Профи.ру), `apps/web` (React, мастер и «Состояние»). Ядро говорит с Профи-MCP только по контракту C2 (MCP) и принимает его события по C8 (HTTP с подтверждением). Всё снаружи (Telegram, Claude, Профи.ру) в тестах подменено фальшивками.

**Tech Stack:** Node 24, pnpm, TypeScript strict, tsx, Vitest, Biome, zod 4, Fastify 5, Drizzle ORM + drizzle-kit, Postgres 16 + pgvector (Docker), DBOS Transact, `@modelcontextprotocol/sdk`, grammY, React 19 + Vite + Tailwind + shadcn/ui, Playwright, GitHub Actions, gitleaks, commitlint, release-please.

**Spec:** `docs/spec/2026-10-22-sara-spec-v1.md` (требования FR/NFR), `docs/product/backlog.md` (истории ST-M0-01..16 с критериями «Дано / Когда / Тогда»), `docs/architecture/contracts.md` (C1-C8), `docs/architecture/data-dictionary.md`, `docs/architecture/tech-radar.md`, ADR в `docs/adr/`, приёмка `docs/quality/acceptance/M0.md`.

## Global Constraints

- Node 24 LTS, TypeScript `strict`, pnpm workspaces; новая библиотека только из колонки «Берём» или «Пробуем» техрадара, иначе ADR.
- Postgres 16 + pgvector; время только UTC (`timestamptz`), показ по Москве; деньги целым числом в рублях; номер заказа Профи.ру строкой (contracts §2).
- Переход этапа клиента только функцией `transition`; каждое изменение порождает событие C1 (data-dictionary, правила).
- Весь текст для людей по-русски, простым языком, **без длинного тире «—»** (NFR-UX-1); деньги `1 250 ₽` с неразрывным пробелом (design-system §4).
- Модель только через `claude -p` по подписке (ADR-001); в CI модель не вызывается; у ролей нет инструментов, `--tools ""` (NFR-SEC-2).
- Шлюз выполняет не больше 2 вызовов одновременно (spec 7.4).
- Секреты не в репозитории; файлы секретов с правами 600 (NFR-SEC-1).
- Тесты никогда не ходят на живой Профи.ру и в настоящий Telegram (ADR-017).
- `callback_data` кнопок: `t:<номер задачи>:<действие>`, до 64 байт (C5).
- Бот принимает команды только из привязанного чата (threat model T9).
- Название каждого теста начинается с номера требования, который он проверяет: `it('FR-LEAD-4: ...')` (traceability).
- Все тесты одной командой `pnpm test` быстрее 5 минут (NFR-MAINT-1).
- Коммиты по Conventional Commits на английском; в `main` только пул-реквестом с зелёным CI (CLAUDE.md).

## Review Focus

1. **Два нажатия «Откликнуться» почти одновременно** (двойной тап, повтор Telegram): ровно один `submit_bid`, второе нажатие отвечает «Уже сделано». Тест в Task 14.
2. **Ответ площадки потерялся после того, как отклик ушёл** (обрыв связи после `submit_bid`): повтор с тем же ключом не создаёт второй отклик, в журнале один `bid.sent`. Тест в Task 14.
3. **Claude не ответил, ответил не по схеме или кончился лимит во время разбора заявки**: заявка не теряется, карточка всё равно приходит с текстом «Сортировщик не ответил, проверь сам», в журнале `model.failed`. Тест в Task 14.
4. **Одна и та же заявка пришла дважды** (повтор доставки того же события или два события с одним номером заказа): одна заявка, одна карточка. Тесты в Task 10 и Task 14.
5. **Нажатие кнопки или /start из чужого чата** после привязки: ничего не происходит, отклика нет, событие `security.foreign_chat`. Тест в Task 11.

---

## Карта файлов

```
package.json, pnpm-workspace.yaml, tsconfig.base.json, biome.json, vitest.config.ts, .nvmrc, .env.example, .gitignore
commitlint.config.mjs, release-please-config.json, .release-please-manifest.json
.github/workflows/ci.yml, .github/workflows/release.yml
infra/compose.dev.yml, infra/docker/core.Dockerfile
scripts/check-dash.ts, scripts/trace.ts, scripts/mind-check.ts, scripts/dev.ts, scripts/smoke-claude-container.sh
scripts/test/*.test.ts                       тесты скриптов
packages/shared/src/contracts/{event,eventTypes,profi,roles,telegram,mind,settings}.ts
packages/shared/src/{format,permit,index}.ts
apps/core/src/config.ts, app.ts, main.ts
apps/core/src/db/{schema,client,migrate}.ts, apps/core/drizzle/   миграции
apps/core/src/journal/journal.ts
apps/core/src/domain/deal.ts
apps/core/src/secrets/store.ts, settings/store.ts
apps/core/src/workflows/{dbos,decisionWait}.ts
apps/core/src/gateway/{gateway,claudeCli,roles,probeCli}.ts
apps/core/src/profi/{client,eventsRoute}.ts
apps/core/src/notify/{notifier,cards,telegram,telegramApi}.ts
apps/core/src/leads/{pipeline,outbox}.ts
apps/core/src/auth/{password,session}.ts
apps/core/src/api/server.ts, setup/routes.ts, health/{checks,routes}.ts, analytics/speed.ts
apps/core/test/**                             тесты ядра, globalSetup.ts
apps/profi-node/src/mcp/{server,http}.ts
apps/profi-node/src/fake/{fakeProfi,main,sampleOrders}.ts
apps/web/src/{main.tsx,App.tsx,api.ts}, pages/{Setup,Login,Health}.tsx, design/tokens.css, components/ui/*
apps/web/e2e/setup.spec.ts, apps/web/playwright.config.ts
roles/probe/{role.md,meta.json}, roles/sorter/{role.md,meta.json,evals/samples.json}
tests/fakes/{fake-claude.mjs,telegramApi.ts,telegramApi.main.ts}
tests/fixtures/orders/*.json
tests/e2e/skeleton.test.ts
```

---

### Task 1: Монорепозиторий, правила кода, проверка длинного тире (ST-M0-01, часть ST-M0-13)

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `biome.json`, `vitest.config.ts`, `.nvmrc`, `.gitignore`, `.env.example`
- Create: `packages/shared/package.json`, `packages/shared/tsconfig.json`, `packages/shared/src/index.ts`; такие же каркасы `apps/core`, `apps/profi-node`, `apps/web` (web создаётся `pnpm create vite` шаблоном `react-ts`, затем переводится на общие правила)
- Create: `scripts/check-dash.ts`
- Test: `scripts/test/check-dash.test.ts`

**Interfaces:**
- Produces: `findLongDashes(paths: string[]): Promise<{file: string, line: number}[]>` в `scripts/check-dash.ts`; корневые скрипты `pnpm check` (biome + `tsc -b --noEmit` по пакетам + `tsx scripts/check-dash.ts`), `pnpm test` (vitest по всем проектам), `pnpm format`.
- Пакеты: `@sara/shared` (exports: `.` → `./src/index.ts`, `./permit` → `./src/permit.ts`), `@sara/core`, `@sara/profi-node`, `@sara/web`. Запуск TypeScript без сборки через `tsx`.
- tsconfig: `strict`, `noUncheckedIndexedAccess`, `module: "preserve"`, `moduleResolution: "bundler"`, `noEmit`, импорты без расширений.
- Проверка тире смотрит `apps/**/src`, `apps/**/test`, `packages/**/src`, `roles/**`, `tests/**`, `scripts/**` и пропускает `docs/**` (там путь старой папки содержит тире законно) и `node_modules`.
- `.gitignore`: `node_modules`, `.sara/`, `.env`, `reports/`, `dist/`, `playwright-report/`, `test-results/`.

- [ ] **Step 1: Write the failing test**

```ts
// scripts/test/check-dash.test.ts
it('NFR-UX-1: reports file and line of a long dash', async () => {
  // временная папка с a.ts: строка 1 обычная, строка 2 содержит "Привет — мир"
  expect(await findLongDashes([dir])).toEqual([{ file: join(dir, 'a.ts'), line: 2 }])
})
it('NFR-UX-1: passes clean files and skips docs', async () => {
  // docs/x.md с тире и src/b.ts без тире
  expect(await findLongDashes([root])).toEqual([])
})
```

- [ ] **Step 2: Run** `pnpm vitest run scripts/test/check-dash.test.ts` → FAIL (`findLongDashes` не определена)
- [ ] **Step 3: Implement** каркас монорепозитория и `findLongDashes`; CLI-режим печатает `файл:строка` и выходит с кодом 1, если есть находки.
- [ ] **Step 4: Run** `pnpm install && pnpm check && pnpm test` → всё зелёное
- [ ] **Step 5: Commit** `chore: monorepo skeleton, lint, typecheck and long dash check`

---

### Task 2: CI, поиск секретов, правила коммитов, выпуски (ST-M0-02, ST-M0-13, ST-M0-16)

**Files:**
- Create: `.github/workflows/ci.yml`, `.github/workflows/release.yml`, `commitlint.config.mjs`, `release-please-config.json`, `.release-please-manifest.json`

**Interfaces:**
- `ci.yml` на `pull_request` и `push` в `main`, задачи: `check` (`pnpm check`), `test` (служба Postgres `pgvector/pgvector:pg16`, `POSTGRES_USER=sara`, `POSTGRES_PASSWORD=sara`, порт `54329:5432`, `DATABASE_URL=postgres://sara:sara@localhost:54329/sara`, затем `pnpm test`), `build` (`pnpm -r build` там, где есть сборка: web), `secrets` (`gitleaks/gitleaks-action@v2`), `commits` (только на PR: `commitlint --from base.sha --to head.sha`), `trace` (из Task 16; до Task 16 задача отсутствует). Действия закреплены по мажорной версии: `actions/checkout@v4`, `actions/setup-node@v4` (node 24, кэш pnpm), `pnpm/action-setup@v4`.
- `release.yml`: `googleapis/release-please-action@v4` на `push` в `main`, `release-type: node`, один пакет `.`, манифест `{".": "0.0.0"}`, права `contents: write`, `pull-requests: write`.
- Включить право действий создавать пул-реквесты: `gh api -X PUT repos/natadvn-hance/sara/actions/permissions/workflow -f default_workflow_permissions=write -F can_approve_pull_request_reviews=true`.

- [ ] **Step 1:** Открыть ветку `st-m0-02-ci`, добавить файлы, открыть пул-реквест.
- [ ] **Step 2: Verify** в пул-реквесте задачи `check`, `test`, `build`, `secrets`, `commits` зелёные (`gh pr checks`).
- [ ] **Step 3: Verify отказ:** временный коммит в ветке-пробе с текстом `const token = "123456789:AAAbbbCCCdddEEEfffGGGhhhIIIjjjKKKlll"` даёт красный `secrets`; коммит `bad message` даёт красный `commits`. Ветку-пробу удалить, не сливать.
- [ ] **Step 4:** Слить пул-реквест; проверить, что release-please открыл пул-реквест выпуска (`gh pr list --label "autorelease: pending"`).
- [ ] **Step 5: Commit** входит в пул-реквест: `ci: checks, tests, secrets scan, commit rules and release-please`

---

### Task 3: Контракты в `packages/shared` (C1, C2, C3, C5, C6, C7 для M0)

**Files:**
- Create: `packages/shared/src/contracts/{event,eventTypes,profi,roles,telegram,mind,settings}.ts`, `packages/shared/src/format.ts`, `packages/shared/src/permit.ts`
- Test: `packages/shared/test/contracts.test.ts`, `packages/shared/test/format.test.ts`, `packages/shared/test/permit.test.ts`

**Interfaces (Produces):**
- `event.ts`: `ACTORS = ['sara','boris','client','system','profi']`, `type Actor`; zod `EventEnvelope` с полями C1 (`id` uuid, `type` из `EVENT_TYPES`, `v` целое > 0, `entity {kind, id}`, `account_id` строка или null, `actor`, `occurred_at` ISO, `recorded_at` ISO необязательно, `causation_id` uuid или null, `correlation_id` uuid, `reason` строка или null, `payload` объект); `type NewEvent = Omit<EventEnvelope,'id'|'recorded_at'> & { id?: string }`; `newEventId(): string` (uuid v7, пакет `uuid`).
- `eventTypes.ts`: `EVENT_TYPES` для M0: `system.started`, `setup.step_completed`, `setting.changed`, `security.foreign_chat`, `telegram.bound`, `health.check_failed`, `profi.order_seen`, `lead.found`, `lead.sorted`, `lead.skipped`, `bid.requested`, `bid.sent`, `bid.failed`, `spend.recorded`, `deal.stage_changed`, `task.created`, `task.resolved`, `task.reminded`, `outbox.queued`, `outbox.attempted`, `outbox.confirmed`, `outbox.failed`, `model.called`, `model.failed`, `notify.failed`.
- `profi.ts`: `ProfiOrder {order_id, title, category, city, text, client_name, budget_text: string|null, bid_price_rub: int ≥ 0, seen_at}`; `SessionHealthInput {account_id}`, `SessionHealthOutput {alive, balance_rub: int|null, presence, egress_ip: string|null}`; `SubmitBidInput {account_id, order_id, text, idempotency_key, permit}`, `SubmitBidOutput {found_on_page, spent_rub, balance_after_rub: int|null}`; `PROFI_ERROR_CLASSES` из C2 (`SESSION_DEAD`, `BANNED`, `LAYOUT_CHANGED`, `NOT_FOUND`, `ORDER_CLOSED`, `NO_MONEY`, `RATE_LIMITED`, `UNCERTAIN`, `INTERNAL`); `PROFI_TOOLS = { 'profi.session_health': {input, output}, 'profi.submit_bid': {input, output} }`.
- `roles.ts`: `MODELS = ['haiku','sonnet','opus']`, `PRIORITIES = ['P0','P1','P2','P3']`, `RoleMeta {name, version, model, fallbackModel?, priority, timeoutMs}`, `SorterOutput {verdict: 'fit'|'maybe'|'reject', reason: string ≤ 200, tags: string[] ≤ 8, confidence: 0..1}`, `ProbeOutput {ok: true}`.
- `telegram.ts`: `TASK_ACTIONS = ['bid','edit','skip','send','take','return','done','move','open']`, `formatCallback(taskId: string, action: TaskAction): string` (бросает ошибку, если длиннее 64 байт UTF-8), `parseCallback(data: string): {taskId: string, action: TaskAction} | null`.
- `mind.ts`: `MindFrontmatter {id, type: 'knowledge'|'understanding'|'speech'|'judgment'|'example', scope: 'shared' | string, status: 'confirmed'|'proposal'|'outdated', version: int ≥ 1, sources: string[] ≥ 1, valid_from: ISO date, valid_to: ISO date | null}`.
- `settings.ts`: `SETUP_STEPS = ['password','telegram','claude']`; `SETTINGS` с ключами `outbound.bids` (boolean, по умолчанию `false`), `outbound.messages` (boolean, `false`), `setup.progress` (`{completed: SetupStep[]}`, `{completed: []}`), `reminder.decision_after_min` (целое, `30`); типы `SettingKey`, `SettingValue<K>`.
- `format.ts`: `formatRub(n: number): string`.
- `permit.ts`: `signPermit(secret: string, idempotencyKey: string): string` (HMAC-SHA256, hex), `verifyPermit(secret, key, permit): boolean` (`timingSafeEqual`).

- [ ] **Step 1: Write the failing tests**

```ts
it('C1: envelope accepts a valid lead.found event', () => {
  expect(EventEnvelope.safeParse(sampleLeadFound).success).toBe(true)
})
it('C1: envelope rejects unknown type and missing correlation_id', () => {
  expect(EventEnvelope.safeParse({ ...sampleLeadFound, type: 'lead.unknown' }).success).toBe(false)
  expect(EventEnvelope.safeParse({ ...sampleLeadFound, correlation_id: undefined }).success).toBe(false)
})
it('C1: newEventId returns time-ordered uuid v7', () => {
  const a = newEventId(); const b = newEventId()
  expect(a < b).toBe(true); expect(a[14]).toBe('7')
})
it('C5: callback round-trips and stays within 64 bytes', () => {
  const id = '0192f3c4-5b6a-7c8d-9e0f-112233445566'
  const data = formatCallback(id, 'bid')
  expect(data).toBe(`t:${id}:bid`)
  expect(Buffer.byteLength(data)).toBeLessThanOrEqual(64)
  expect(parseCallback(data)).toEqual({ taskId: id, action: 'bid' })
  expect(parseCallback('t:x:fly')).toBeNull()
})
it('C2: submit_bid input requires idempotency_key and permit', () => {
  expect(PROFI_TOOLS['profi.submit_bid'].input.safeParse({ account_id: 'a', order_id: '1', text: 't' }).success).toBe(false)
})
it('C6: mind frontmatter rejects empty sources', () => {
  expect(MindFrontmatter.safeParse({ ...validRecord, sources: [] }).success).toBe(false)
})
it('NFR-UX-1: formatRub uses a no-break space', () => {
  expect(formatRub(1250)).toBe('1 250 ₽'); expect(formatRub(210)).toBe('210 ₽')
})
it('C2: permit verifies only for its own key', () => {
  const p = signPermit('s', 'bid:123')
  expect(verifyPermit('s', 'bid:123', p)).toBe(true)
  expect(verifyPermit('s', 'bid:124', p)).toBe(false)
})
```

- [ ] **Step 2: Run** `pnpm vitest run packages/shared` → FAIL
- [ ] **Step 3: Implement** схемы на zod 4; JSON Schema из них получать `z.toJSONSchema`, руками не писать.
- [ ] **Step 4: Run** `pnpm vitest run packages/shared` → PASS
- [ ] **Step 5: Commit** `feat(shared): contracts C1, C2, C3, C5, C6, C7 for M0`

---

### Task 4: База, схема и запуск Postgres (ST-M0-03, часть)

**Files:**
- Create: `infra/compose.dev.yml` (служба `postgres`: `pgvector/pgvector:pg16`, пользователь и пароль `sara`, база `sara`, порт `54329:5432`, том `pg-dev`, healthcheck `pg_isready`)
- Create: `apps/core/src/config.ts`, `apps/core/src/db/{schema,client,migrate}.ts`, `apps/core/drizzle.config.ts`, миграции в `apps/core/drizzle/`
- Create: `apps/core/test/globalSetup.ts`, `apps/core/test/helpers/db.ts`
- Test: `apps/core/test/db/schema.test.ts`

**Interfaces:**
- Produces: `loadConfig(env = process.env): Config` с полями `databaseUrl` (по умолчанию `postgres://sara:sara@localhost:54329/sara`), `dataDir` (`./.sara`), `port` (`3000`), `publicUrl` (`http://localhost:5173`), `profiMcpUrl` (`http://localhost:7070/mcp`), `nodeToken`, `permitSecret` (в разработке по умолчанию `dev-node-token` и `dev-permit-secret`; при `NODE_ENV=production` без них запуск падает с понятной ошибкой), `claudeBin` (`claude`), `telegramApiRoot` (необязательно), `rolesDir` (`<корень>/roles`).
- `createDb(url: string): { db: Db, close(): Promise<void> }`; типы `Db`, `Tx`; `migrate(url: string): Promise<void>`.
- Таблицы в схеме `core` (поля и классы данных по словарю данных, раздел 3): `event` (поля конверта C1, `entity_kind`, `entity_id`; индексы `(entity_kind, entity_id)`, `(correlation_id)`, `(type, occurred_at)`), `lead` (+ `correlation_id uuid`, `status` из словаря), `deal` (`lead_id` уникален), `task` (+ `resolved_at`), `outbox` (`idempotency_key` уникален), `model_call`, `setting`, `setting_history`, `owner_auth` (одна строка, `id = 1`).
- Ручная миграция (`drizzle-kit generate --custom`): триггер `core.event_append_only` BEFORE UPDATE OR DELETE на `core.event` с ошибкой `event journal is append-only`. TRUNCATE триггер не ловит: им пользуются только тесты.
- Тестовая база `sara_test`: `globalSetup` создаёт её, если нет, и прогоняет миграции; `resetDb(db)` делает `TRUNCATE` всех таблиц схемы `core`.

- [ ] **Step 1: Write the failing test**

```ts
it('FR-OPS-4: journal rejects update and delete', async () => {
  await db.execute(sql`insert into core.event (...) values (...)`) // одно событие
  await expect(db.execute(sql`update core.event set reason = 'x'`)).rejects.toThrow(/append-only/)
  await expect(db.execute(sql`delete from core.event`)).rejects.toThrow(/append-only/)
})
it('FR-LEAD-4: outbox idempotency_key is unique', async () => {
  await insertOutbox({ idempotency_key: 'bid:1' })
  await expect(insertOutbox({ idempotency_key: 'bid:1' })).rejects.toThrow()
})
```

- [ ] **Step 2:** Запустить Docker Desktop (`open -a Docker`), затем `docker compose -f infra/compose.dev.yml up -d --wait`.
- [ ] **Step 3: Run** `pnpm vitest run apps/core/test/db` → FAIL
- [ ] **Step 4: Implement** схему, миграции, `createDb`, `migrate`, `loadConfig`.
- [ ] **Step 5: Run** `pnpm vitest run apps/core/test/db` → PASS
- [ ] **Step 6: Commit** `feat(core): database schema, append-only journal trigger, dev Postgres`

---

### Task 5: Журнал событий и машина состояний клиента (ST-M0-04)

**Files:**
- Create: `apps/core/src/journal/journal.ts`, `apps/core/src/domain/deal.ts`
- Test: `apps/core/test/journal.test.ts`, `apps/core/test/deal.test.ts`

**Interfaces:**
- Consumes: `EventEnvelope`, `NewEvent`, `newEventId` (Task 3); `Db`, `Tx` (Task 4).
- Produces:
  - `appendEvent(db: Db | Tx, e: NewEvent): Promise<EventEnvelope>` (проверяет конверт схемой, ставит `id` и `recorded_at`).
  - `appendEventIfNew(db: Db | Tx, e: EventEnvelope): Promise<boolean>` (вставка с `ON CONFLICT (id) DO NOTHING`; `true`, если новое).
  - `listEvents(db, filter: { correlationId?: string; type?: string }): Promise<EventEnvelope[]>` по порядку `id`.
  - `DEAL_STAGES` (спецификация 7.2), `type DealStage`, `ALLOWED_TRANSITIONS`, `class TransitionError`.
  - `createDeal(db: Db | Tx, i: { leadId: string; accountId: string; correlationId: string }): Promise<string>`: клиент создаётся на этапе `bid_sent`, владелец `sara`, ход `client`, событие `deal.stage_changed` `{from: null, to: 'bid_sent'}`.
  - `transition(db: Db, i: { dealId: string; to: DealStage; actor: Actor; reason: string | null; correlationId: string }): Promise<void>`: одна транзакция, `SELECT … FOR UPDATE`, проверка таблицы, обновление, событие `deal.stage_changed` `{from, to}`.
- Таблица переходов (решение плана; этапы из спецификации):

| Из | Можно в |
|---|---|
| `found` | `queued`, `lost` |
| `queued` | `bid_sent`, `lost` |
| `bid_sent` | `talking`, `lost`, `dormant` |
| `talking` | `call_proposed`, `won`, `lost`, `dormant` |
| `call_proposed` | `call_booked`, `talking`, `lost`, `dormant` |
| `call_booked` | `call_done`, `call_proposed`, `lost` |
| `call_done` | `won`, `lost`, `talking` |
| `dormant` | `talking`, `lost` |
| `won`, `lost` | никуда |

- [ ] **Step 1: Write the failing tests**

```ts
it('FR-OPS-4: appendEvent stores a C1 envelope and returns it with id', async () => {
  const e = await appendEvent(db, leadFoundInput)
  expect(e.id).toMatch(uuidV7); expect((await listEvents(db, { correlationId: e.correlation_id }))[0]).toEqual(e)
})
it('FR-OPS-4: appendEventIfNew ignores a repeated id', async () => {
  const e = { ...envelope, id: newEventId() }
  expect(await appendEventIfNew(db, e)).toBe(true); expect(await appendEventIfNew(db, e)).toBe(false)
})
it('NFR-REL-3: forbidden transition writes nothing', async () => {
  const id = await createDeal(db, base)
  await expect(transition(db, { dealId: id, to: 'won', actor: 'sara', reason: null, correlationId })).rejects.toBeInstanceOf(TransitionError)
  expect(await stageOf(id)).toBe('bid_sent'); expect(await countEvents('deal.stage_changed')).toBe(1)
})
it('NFR-REL-3: stage and event are written in one transaction', async () => {
  // подменить appendEvent так, чтобы он бросил ошибку; этап не должен измениться
})
```

- [ ] **Step 2: Run** `pnpm vitest run apps/core/test/journal.test.ts apps/core/test/deal.test.ts` → FAIL
- [ ] **Step 3: Implement** `journal.ts` и `deal.ts`.
- [ ] **Step 4: Run** → PASS
- [ ] **Step 5: Commit** `feat(core): event journal and deal state machine`

---

### Task 6: Устойчивые процессы на DBOS (ST-M0-05, проверка ADR-006)

**Files:**
- Create: `apps/core/src/workflows/dbos.ts`, `apps/core/src/workflows/decisionWait.ts`
- Create: `apps/core/test/workflows/decisionWaitWorker.ts` (процесс для теста)
- Test: `apps/core/test/workflows/decisionWait.kill.test.ts`

**Interfaces:**
- Consumes: `appendEvent` (Task 5).
- Produces:
  - `launchDbos(databaseUrl: string): Promise<void>`, `shutdownDbos(): Promise<void>`.
  - `setReminderHandler(h: (taskId: string) => Promise<void>): void`.
  - `startDecisionWait(taskId: string, remindAfterMs: number): Promise<void>`: процесс с номером `decision:<taskId>` (повторный старт с тем же номером не создаёт второй процесс); ждёт сообщение темы `decision` до `remindAfterMs`; если не дождался, один раз вызывает обработчик напоминания шагом DBOS и ждёт дальше без новых напоминаний (в M0 одно напоминание).
  - `deliverDecision(taskId: string, resolution: TaskAction): Promise<void>`: отправляет сообщение в процесс `decision:<taskId>`.
- Точные вызовы DBOS (`registerWorkflow`, `recv`, `send`, `runStep`, `startWorkflow` с номером процесса) сверить с документацией закреплённой версии `@dbos-inc/dbos-sdk` (docs.dbos.dev); системная база DBOS отдельная, по умолчанию её создаёт DBOS.
- Рабочий процесс теста запускает DBOS, ставит обработчик, который пишет событие `task.reminded`, и вызывает `startDecisionWait(taskId, 3000)`.

- [ ] **Step 1: Write the failing test**

```ts
it('NFR-REL-3: reminder fires once after the process is killed and restarted', async () => {
  const first = spawnWorker(taskId)                 // tsx decisionWaitWorker.ts <taskId> 3000
  await sleep(1000); first.kill('SIGKILL')
  const second = spawnWorker(taskId)
  await waitFor(() => countEvents('task.reminded', taskId), 1, { timeoutMs: 8000 })
  await sleep(2000)
  expect(await countEvents('task.reminded', taskId)).toBe(1)
  second.kill()
})
it('NFR-REL-3: delivered decision cancels the reminder', async () => {
  // старт, deliverDecision(taskId, 'bid') через 500 мс, ждать 5 с: напоминаний 0
})
```

- [ ] **Step 2: Run** `pnpm vitest run apps/core/test/workflows` → FAIL
- [ ] **Step 3: Implement** `dbos.ts`, `decisionWait.ts`, рабочий процесс теста.
- [ ] **Step 4: Run** → PASS
- [ ] **Step 5: Если за один рабочий день тест не проходит на DBOS:** записать `docs/adr/0023-pg-boss-instead-of-dbos.md` (контекст: что не получилось), заменить реализацию на очередь pg-boss в той же базе с тем же интерфейсом (`startDecisionWait`, `deliverDecision`, `setReminderHandler`), тесты не менять.
- [ ] **Step 6: Commit** `feat(core): durable decision wait on DBOS`

---

### Task 7: Хранилище секретов и настроек (ST-M0-13, C7)

**Files:**
- Create: `apps/core/src/secrets/store.ts`, `apps/core/src/settings/store.ts`
- Test: `apps/core/test/secrets.test.ts`, `apps/core/test/settings.test.ts`

**Interfaces:**
- Produces:
  - `type SecretName = 'telegram_bot_token' | 'claude_oauth_token' | 'session_secret'`.
  - `createSecretStore(dataDir: string): SecretStore` с `get(name): Promise<string | null>`, `set(name, value): Promise<void>`, `ensure(name, generate: () => string): Promise<string>`. Файл `<dataDir>/secrets.json`, права `0o600`, папка `0o700`, запись через временный файл и `rename`.
  - `getSetting<K extends SettingKey>(db, key: K): Promise<SettingValue<K>>` (нет строки → значение по умолчанию из `SETTINGS`), `setSetting<K>(db, key: K, value: SettingValue<K>, changedBy: Actor): Promise<void>` (проверка схемой, строка в `setting_history`, событие `setting.changed` без значения секретов).

- [ ] **Step 1: Write the failing tests**

```ts
it('NFR-SEC-1: secrets file is created with mode 600', async () => {
  await store.set('telegram_bot_token', 'x')
  expect((await stat(join(dir, 'secrets.json'))).mode & 0o777).toBe(0o600)
})
it('C7: unknown setting value is rejected and default is returned when unset', async () => {
  expect(await getSetting(db, 'outbound.bids')).toBe(false)
  await expect(setSetting(db, 'reminder.decision_after_min', -1 as never, 'boris')).rejects.toThrow()
})
it('C7: setting change writes history and event', async () => {
  await setSetting(db, 'outbound.bids', true, 'boris')
  expect(await countRows('core.setting_history')).toBe(1); expect(await countEvents('setting.changed')).toBe(1)
})
```

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS
- [ ] **Step 5: Commit** `feat(core): secret file store and settings with history`

---

### Task 8: Шлюз модели (ST-M0-06)

**Files:**
- Create: `apps/core/src/gateway/{gateway,claudeCli,roles}.ts`, `tests/fakes/fake-claude.mjs`
- Create: `roles/probe/role.md`, `roles/probe/meta.json`
- Test: `apps/core/test/gateway.test.ts`

**Interfaces:**
- Consumes: `RoleMeta`, `ProbeOutput` (Task 3), `SecretStore` (Task 7), `Db` (Task 4).
- Produces:
  - `loadRole(rolesDir: string, name: RoleName): Promise<{ meta: RoleMeta; promptPath: string }>`; `type RoleName = 'probe' | 'sorter'`.
  - `buildClaudeArgs(meta: RoleMeta, promptPath: string, jsonSchema: object): string[]`, ровно в таком порядке: `-p`, `--model <meta.model>`, `--fallback-model <meta.fallbackModel>` (если задан), `--system-prompt-file <promptPath>`, `--output-format json`, `--json-schema <JSON строкой>`, `--tools ""` (пустая строка отдельным аргументом), `--strict-mcp-config`, `--setting-sources project`, `--permission-mode dontAsk`, `--permission-prompts none`, `--no-session-persistence`. `--max-turns` не передаётся: в справке CLI 2.1.308 его нет, а без инструментов он не нужен; ограничение по времени держит шлюз.
  - `runClaude(o: { bin: string; args: string[]; input: string; token: string; cwd: string; timeoutMs: number }): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean; durationMs: number }>`; вход идёт через stdin; окружение процесса только `PATH`, `HOME`, `CLAUDE_CODE_OAUTH_TOKEN`; рабочая папка пустая `<dataDir>/claude-cwd`.
  - `type GatewayErrorClass = 'not_connected' | 'timeout' | 'bad_output' | 'cli_failed' | 'limit_reached'`.
  - `type RoleCallResult<T> = { ok: true; output: T; durationMs: number; modelCallId: string } | { ok: false; errorClass: GatewayErrorClass; message: string; durationMs: number; modelCallId: string }`.
  - `createGateway(d: { db: Db; secrets: SecretStore; claudeBin: string; rolesDir: string; dataDir: string; concurrency?: number }): Gateway` (по умолчанию `concurrency = 2`), `gateway.call<T>(role: RoleName, input: string, schema: ZodType<T>, opts?: { correlationId?: string; causationId?: string }): Promise<RoleCallResult<T>>`. Каждый вызов пишет строку `model_call` и событие `model.called` или `model.failed` с `correlation_id` из `opts` (нет → новый).
- Разбор ответа: stdout это JSON; ответ роли в поле `structured_output`; нет поля или оно не проходит схему → `bad_output`. Нет токена → `not_connected` без запуска CLI. Код выхода не 0 и в stdout или stderr есть `usage limit` или `rate limit` (без учёта регистра) → `limit_reached`; иначе `cli_failed`. Превышение `meta.timeoutMs` → процесс убивается, `timeout`.
- `roles/probe`: `meta.json` `{ "name": "probe", "version": 1, "model": "haiku", "priority": "P0", "timeoutMs": 30000 }`; `role.md`: «Ответь объектом {"ok": true}.»
- `fake-claude.mjs` управляется переменными `FAKE_CLAUDE_MODE` (`ok`, `no_structured`, `bad_json`, `sleep`, `exit1`, `limit`), `FAKE_CLAUDE_OUTPUT` (JSON для `structured_output`), `FAKE_CLAUDE_ARGS_LOG` (файл, куда дописываются аргументы, для проверок).

- [ ] **Step 1: Write the failing tests**

```ts
it('LLM-3: builds the exact CLI contract with tools disabled', () => {
  const args = buildClaudeArgs(probeMeta, '/r/probe/role.md', { type: 'object' })
  expect(args).toEqual(['-p','--model','haiku','--system-prompt-file','/r/probe/role.md','--output-format','json',
    '--json-schema','{"type":"object"}','--tools','','--strict-mcp-config','--setting-sources','project',
    '--permission-mode','dontAsk','--permission-prompts','none','--no-session-persistence'])
})
it('FR-SET-3: returns validated structured output and records model_call', async () => {
  const r = await gw.call('probe', 'проверка', ProbeOutput)   // FAKE_CLAUDE_MODE=ok, OUTPUT={"ok":true}
  expect(r).toMatchObject({ ok: true, output: { ok: true } }); expect(await countRows('core.model_call')).toBe(1)
})
it('LLM-3: missing structured_output is bad_output, not an empty answer', async () => {
  expect(await gw.call('probe', 'x', ProbeOutput)).toMatchObject({ ok: false, errorClass: 'bad_output' })
})
it('FR-SET-3: no token gives not_connected without spawning the CLI', async () => { /* args log пуст */ })
it('FR-OPS-3: limit text gives limit_reached', async () => { /* MODE=limit */ })
it('LLM-1: timeout kills the CLI and reports timeout', async () => { /* MODE=sleep, timeoutMs 300 */ })
it('LLM-1: runs at most two calls at once', async () => {
  // 5 вызовов с MODE=sleep 300 мс; по меткам времени из ARGS_LOG одновременно не больше 2
})
```

- [ ] **Step 2: Run** `pnpm vitest run apps/core/test/gateway.test.ts` → FAIL
- [ ] **Step 3: Implement** шлюз, раннер CLI, загрузку ролей, фальшивый CLI, роль `probe`.
- [ ] **Step 4: Run** → PASS
- [ ] **Step 5: Commit** `feat(core): model gateway over claude -p with concurrency 2`

---

### Task 9: Роль Сортировщик, версия 0 (ST-M0-07)

**Files:**
- Create: `roles/sorter/role.md`, `roles/sorter/meta.json`, `roles/sorter/evals/samples.json`, `tests/fixtures/orders/*.json` (10 заказов)
- Create: `apps/core/src/gateway/evalRole.ts` (команда `pnpm role:eval sorter`)
- Test: `apps/core/test/sorter.test.ts`

**Interfaces:**
- Consumes: `Gateway` (Task 8), `SorterOutput`, `ProfiOrder` (Task 3).
- Produces: `sortOrder(gw: Gateway, o: ProfiOrder): Promise<RoleCallResult<SorterOutput>>` в `apps/core/src/leads/sorter.ts`; вход роли это текст: тема, категория, город, бюджет, описание (имя клиента не передаётся).
- `meta.json`: `{ "name": "sorter", "version": 0, "model": "haiku", "fallbackModel": "sonnet", "priority": "P2", "timeoutMs": 60000 }`.
- `role.md` по-русски: Сортировщик агентства Hance (маркетинг, сайты, реклама, SMM, стратегия) отделяет явно чужие заказы; `fit`, если задача про маркетинг, рекламу, продвижение, сайт, бренд; `reject`, если явно другая сфера; `maybe`, если непонятно; причина одной фразой до 200 знаков, без длинного тире.
- 10 заказов: 6 подходящих (сайт для клиники, таргет для кофейни, SMM салона, стратегия запуска, контекстная реклама, лендинг), 4 чужих (репетитор по химии, ремонт квартиры, бухгалтерия, перевозка мебели). `samples.json`: `[{ "order": "<файл>", "expected": "fit" | "reject" }]`. Данные выдуманные, без настоящих имён.
- `pnpm role:eval sorter` вызывает настоящий `claude -p` (только вручную на Маке или сервере, не в CI) и печатает совпадение `N из 10`; цель не ниже 8 из 10.

- [ ] **Step 1: Write the failing test** (на фальшивом CLI)

```ts
it('FR-LEAD-2: sends order text without client name and parses verdict', async () => {
  const r = await sortOrder(gw, order)   // FAKE_CLAUDE_OUTPUT={"verdict":"fit","reason":"Сайт для клиники","tags":["сайт"],"confidence":0.9}
  expect(r).toMatchObject({ ok: true, output: { verdict: 'fit' } })
  expect(readStdinLog()).not.toContain(order.client_name)
})
```

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS
- [ ] **Step 5: Manual check** `pnpm role:eval sorter` на Маке с токеном Бориса (после шага 6 порядка старта) → `8 из 10` или лучше; итог записать в описание пул-реквеста.
- [ ] **Step 6: Commit** `feat(roles): sorter v0 with ten eval samples`

---

### Task 10: Фальшивый Профи.ру по контракту C2 и приём событий C8 (ST-M0-08)

**Files:**
- Create: `apps/profi-node/src/mcp/server.ts`, `apps/profi-node/src/mcp/http.ts`, `apps/profi-node/src/fake/{fakeProfi,sampleOrders,main}.ts`
- Create: `apps/core/src/profi/client.ts`, `apps/core/src/profi/eventsRoute.ts`
- Test: `apps/profi-node/test/fakeProfi.test.ts`, `apps/core/test/profiClient.test.ts`

**Interfaces:**
- Consumes: `PROFI_TOOLS`, `ProfiOrder`, `EventEnvelope`, `signPermit`/`verifyPermit` (Task 3); `appendEventIfNew` (Task 5).
- Produces:
  - `createProfiMcpServer(impl: ProfiToolsImpl): Server` на низкоуровневом `Server` из `@modelcontextprotocol/sdk` (обработчики `tools/list` и `tools/call`), схемы инструментов это JSON Schema из `PROFI_TOOLS` через `z.toJSONSchema`; вход проверяется нашей схемой zod. Так версия zod внутри SDK не важна. `ProfiToolsImpl { sessionHealth(i: SessionHealthInput): Promise<SessionHealthOutput>; submitBid(i: SubmitBidInput): Promise<SubmitBidOutput> }`. Ошибка инструмента возвращается как `isError: true` с текстом `{ "errorClass": "<класс C2>", "message": "..." }`.
  - `serveMcp(make: () => Server, port: number): Promise<{ url: string; close(): Promise<void> }>`: Streamable HTTP без сессий на пути `/mcp`.
  - `createFakeProfi(o: { port: number; coreEventsUrl: string; nodeToken: string; permitSecret: string }): Promise<FakeProfi>`; `FakeProfi { url; bids: SubmitBidInput[]; emitOrder(o?: Partial<ProfiOrder>): Promise<string>; failNextAck(): void; setHealth(h: Partial<SessionHealthOutput>): void; close() }`. `submit_bid` проверяет `permit`; при повторе того же `idempotency_key` возвращает первый итог и не добавляет запись в `bids`; `failNextAck()` записывает отклик, но рвёт ответ (для Review Focus 2). `emitOrder` шлёт конверт C1 типа `profi.order_seen` (актор `profi`, `payload` = заказ) на `coreEventsUrl` с заголовком `x-sara-node-token`, до 3 попыток с паузой 200 мс, и возвращает номер события.
  - `fake/main.ts`: запуск на порту 7070; `POST /fake/orders` выпускает случайный заказ из `tests/fixtures/orders` (команда `pnpm fake:order`).
  - `createProfiClient(o: { url: string; permitSecret: string }): ProfiClient` с `sessionHealth(accountId)`, `submitBid(i: Omit<SubmitBidInput, 'permit'>)` (подписывает `permit` сам), `close()`; ошибки инструментов бросаются как `ProfiError { errorClass: ProfiErrorClass }`, обрыв связи как `ProfiError('UNCERTAIN')`.
  - `registerProfiEventsRoute(app: FastifyInstance, d: { db: Db; nodeToken: string; onEvent(e: EventEnvelope): Promise<void> })`: `POST /internal/profi/events`; неверный токен → 401; неверный конверт → 400; `appendEventIfNew`; новое событие передаётся в `onEvent`; ответ `{ accepted: true, duplicate: boolean }`.

- [ ] **Step 1: Write the failing tests**

```ts
it('C2: fake tools match the contract schemas', async () => {
  const tools = await mcpClient.listTools()
  expect(tools.tools.map(t => t.name).sort()).toEqual(['profi.session_health', 'profi.submit_bid'])
})
it('C2: repeated idempotency_key returns the first result and records one bid', async () => {
  const a = await client.submitBid(bid); const b = await client.submitBid(bid)
  expect(b).toEqual(a); expect(fake.bids).toHaveLength(1)
})
it('C2: submit_bid without a valid permit is rejected', async () => { /* errorClass INTERNAL, bids пуст */ })
it('C8: the same order_seen delivered twice is accepted once', async () => {
  const id = await fake.emitOrder(); await redeliver(id)
  expect(onEvent).toHaveBeenCalledTimes(1); expect(await countEvents('profi.order_seen')).toBe(1)
})
it('C8: wrong node token is refused', async () => { /* 401, событий нет */ })
```

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS
- [ ] **Step 5: Commit** `feat(profi-node): fake Profi-MCP over C2 and core event intake over C8`

---

### Task 11: Бот: привязка чата, карточка, нажатия (ST-M0-09)

**Files:**
- Create: `apps/core/src/notify/{notifier,cards,telegram,telegramApi}.ts`, `tests/fakes/telegramApi.ts`, `tests/fakes/telegramApi.main.ts`
- Test: `apps/core/test/bot.test.ts`, `apps/core/test/cards.test.ts`

**Interfaces:**
- Consumes: `formatCallback`, `parseCallback`, `formatRub` (Task 3); `appendEvent` (Task 5).
- Produces:
  - `type LeadCard = { taskId: string; title: string; city: string; verdict: 'fit' | 'maybe' | null; reason: string | null; bidPriceRub: number }` (`verdict = null`, если Сортировщик не ответил).
  - `interface Notifier { sendLeadCard(c: LeadCard): Promise<{ messageId: number }>; sendText(text: string): Promise<void> }`.
  - `cards.ts`: `leadCardText(c: LeadCard): string`, `leadCardKeyboard(c: LeadCard)`, константы `TEXTS`. Точные тексты:
    - карточка: `🔔 Заявка · {title}, {city}` / вторая строка `Подходит: {reason}` или `Возможно: {reason}` или `Сортировщик не ответил, проверь сам` / третья строка `Отклик {formatRub(price)}`;
    - кнопки: `Откликнуться за {formatRub(price)}` (`bid`), `Пропустить` (`skip`);
    - `TEXTS.bound = 'Сара на связи'`, `TEXTS.alreadyDone = 'Уже сделано'`, `TEXTS.bidSent(title, price) = '✅ Отклик отправлен: {title}, {formatRub(price)}'`, `TEXTS.reminder(title) = '⏰ Заявка ждёт решения: {title}'`, `TEXTS.bidsPaused = 'Отклик не ушёл: отправка откликов на паузе'`, `TEXTS.skipped = 'Пропущено'`, `TEXTS.bidQueued = 'Отправляю отклик'`.
  - `getMe(token: string, apiRoot?: string): Promise<{ ok: true; username: string } | { ok: false; reason: 'unauthorized' | 'network' }>`.
  - `createTelegramRuntime(d: { token: string; apiRoot?: string; db: Db; onPress(p: { taskId: string; action: TaskAction }): Promise<string> }): TelegramRuntime` с `start()`, `stop()`, `notifier: Notifier`. Длинный опрос grammY (`client.apiRoot` для фальшивки). `/start`: чат не привязан → привязать (`owner_auth.telegram_chat_id`, `telegram_user_id`), событие `telegram.bound`, ответ `Сара на связи`; привязан этот же чат → ответ `Сара на связи`; другой чат → молчать, событие `security.foreign_chat` `{ chat_id }`. Любое другое обновление из чужого чата молча отбрасывается с тем же событием. Нажатие из своего чата: `parseCallback`, `onPress`, ответ на нажатие текстом, который вернул `onPress`.
  - Фальшивый Telegram: `createFakeTelegram(): Promise<FakeTelegram>` (`apiRoot`, `token`, `sent`, `answers`, `pushStart(chatId)`, `pushPress(chatId, data): string`, `close()`); методы `getMe`, `getUpdates` (с `offset` и коротким ожиданием), `sendMessage`, `answerCallbackQuery`, `editMessageReplyMarkup`, `deleteWebhook`, `setMyCommands`. `telegramApi.main.ts` поднимает его на порту 18081 с `POST /_control/start {chatId}` для Playwright.

- [ ] **Step 1: Write the failing tests**

```ts
it('FR-SET-2: first /start binds the chat and says hello', async () => {
  tg.pushStart(111); await until(() => tg.sent.length === 1)
  expect(tg.sent[0]).toMatchObject({ chat_id: 111, text: 'Сара на связи' }); expect(await boundChat()).toBe(111)
})
it('FR-NOTIF-1: lead card text, buttons and callback format', () => {
  expect(leadCardText(card)).toBe('🔔 Заявка · Сайт для клиники, Краснодар\nПодходит: Нужен сайт\nОтклик 210 ₽')
  expect(leadCardKeyboard(card).inline_keyboard[0][0]).toEqual({ text: 'Откликнуться за 210 ₽', callback_data: `t:${card.taskId}:bid` })
})
it('NFR-UX-1: no card text contains a long dash', () => { /* все TEXTS и карточка */ })
it('T9: press from a foreign chat does nothing and is logged', async () => {
  tg.pushStart(111); tg.pushPress(222, `t:${taskId}:bid`); await settle()
  expect(onPress).not.toHaveBeenCalled(); expect(await countEvents('security.foreign_chat')).toBe(1)
})
it('T9: /start from another chat after binding does not rebind', async () => { /* привязка остаётся 111 */ })
```

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS
- [ ] **Step 5: Commit** `feat(core): telegram bot with chat binding and lead cards`

---

### Task 12: API ядра, вход владельца, мастер шаги 1-3, проверки состояния (ST-M0-10, ST-M0-11, сервер)

**Files:**
- Create: `apps/core/src/api/server.ts`, `apps/core/src/auth/{password,session}.ts`, `apps/core/src/setup/routes.ts`, `apps/core/src/health/{checks,routes}.ts`, `apps/core/src/gateway/probeCli.ts`
- Test: `apps/core/test/setup.test.ts`, `apps/core/test/health.test.ts`

**Interfaces:**
- Consumes: `createGateway` (Task 8), `createSecretStore`, `getSetting`/`setSetting` (Task 7), `getMe`, `createTelegramRuntime` (Task 11), `createProfiClient` (Task 10).
- Produces:
  - `hashPassword(p: string): Promise<string>` (scrypt из `node:crypto`, соль 16 байт), `verifyPassword(p: string, h: string): Promise<boolean>`.
  - Сессия: подписанная cookie `sara_session` (`@fastify/cookie`, секрет `session_secret` из хранилища, `httpOnly`, `sameSite: 'strict'`, `secure` в работе, срок 30 дней).
  - `buildServer(d: AppDeps): Promise<FastifyInstance>`; `AppDeps` содержит `db`, `secrets`, `gateway`, `profi`, `bot: BotControl` (`start(token)`, `isBound()`, `botUsername()`), `config`.
  - Маршруты (тела и ответы проверяются zod):
    - `GET /api/setup` → `{ next: 'password' | 'telegram' | 'claude' | 'done'; completed: SetupStep[] }` (из настройки `setup.progress`).
    - `POST /api/setup/password { password }`: меньше 10 знаков → 400 `Пароль должен быть не короче 10 знаков.`; пароль уже задан → 409; иначе хэш, сессия, шаг `password` выполнен, событие `setup.step_completed`.
    - `POST /api/login { password }`: больше 5 попыток в минуту → 429 `Слишком много попыток. Подожди минуту.`
    - `POST /api/setup/telegram { token }` (нужна сессия): пробелы и переводы строк обрезаются; формат `^\d+:[A-Za-z0-9_-]{30,}$`, иначе 400 `Это не похоже на токен бота. Скопируй его из сообщения @BotFather целиком: цифры, двоеточие и длинная строка.`; `getMe` `unauthorized` → 400 `Telegram не узнал этот токен. Проверь, что скопировал последний токен из @BotFather, или выпусти новый командой /token.`; `network` → 502 `Не получилось связаться с Telegram. Проверь интернет и попробуй ещё раз.`; успех → токен в хранилище, `bot.start(token)`, ответ `{ botUsername }`.
    - `GET /api/setup/telegram/status` → `{ bound: boolean; botUsername: string | null }`; при первой привязке шаг `telegram` выполнен.
    - `POST /api/setup/claude { token }`: токен в хранилище, вызов роли `probe`; успех → `{ ok: true, durationMs }`, шаг `claude` выполнен; `not_connected` или `cli_failed` → 400 `Claude не принял токен. Запусти на Маке claude setup-token ещё раз и вставь новый токен.`; `timeout` → 504 `Claude не ответил за 30 секунд. Попробуй ещё раз; если повторится, проверь лимит подписки.`; `limit_reached` → 429 `Лимит подписки Claude исчерпан. Шаг можно пройти позже.`
    - `GET /api/health` → `{ checks: HealthCheck[] }`; `POST /api/health/claude` повторяет пробный вызов.
  - `type HealthCheck = { id: 'db' | 'telegram' | 'claude' | 'profi'; ok: boolean; title: string; detail: string; fix: string | null }`; `runHealthChecks(d: AppDeps): Promise<HealthCheck[]>`: база (`select 1`), Telegram (токен есть, `getMe` ответил, чат привязан), Claude (последний пробный вызов за 24 часа удачный; сам по себе Claude не вызывается), Профи.ру (`profi.session_health` жива). Заголовки: `База данных`, `Telegram`, `Claude`, `Профи.ру`; у непрошедшей проверки `fix` говорит, что сделать (например, `Открой мастер запуска, шаг Telegram`).
  - `probeCli.ts`: команда `pnpm probe:claude`, печатает `ok за N мс` или класс ошибки; используется в Task 15.

- [ ] **Step 1: Write the failing tests** (Fastify `inject`, фальшивые CLI и Telegram)

```ts
it('FR-SET-1: wizard resumes from the step where it stopped', async () => {
  await post('/api/setup/password', { password: 'длинныйпароль1' })
  expect((await get('/api/setup')).json()).toEqual({ next: 'telegram', completed: ['password'] })
})
it('FR-SET-2: token with spaces is trimmed; wrong format explains how to fix', async () => {
  expect((await post('/api/setup/telegram', { token: 'abc' })).json().error).toMatch(/@BotFather целиком/)
  expect((await post('/api/setup/telegram', { token: ` ${tg.token}\n` })).statusCode).toBe(200)
})
it('FR-SET-2: token unknown to Telegram gives the BotFather hint', async () => { /* 400, /token */ })
it('FR-SET-3: claude step runs the probe and reports duration under 30 s', async () => {
  const r = (await post('/api/setup/claude', { token: 't' })).json()
  expect(r.ok).toBe(true); expect(r.durationMs).toBeLessThan(30000)
})
it('FR-SET-5: health lists four checks with fix text for failures', async () => {
  const { checks } = (await get('/api/health')).json()
  expect(checks.map(c => c.id)).toEqual(['db', 'telegram', 'claude', 'profi'])
  expect(checks.find(c => !c.ok)?.fix).toBeTruthy()
})
it('T11: setup routes after password need a session', async () => { /* без cookie 401 */ })
```

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS
- [ ] **Step 5: Commit** `feat(core): owner auth, setup wizard API steps 1-3 and health checks`

---

### Task 13: Пульт: мастер, вход, «Состояние системы» (ST-M0-10, ST-M0-11, интерфейс)

**Files:**
- Create: `apps/web/src/{main.tsx,App.tsx,api.ts}`, `apps/web/src/pages/{Setup,Login,Health}.tsx`, `apps/web/src/design/tokens.css`, `apps/web/src/components/ui/*` (shadcn/ui: `button`, `input`, `card`), `apps/web/vite.config.ts` (прокси `/api` на `http://localhost:3000`), `apps/web/playwright.config.ts`
- Test: `apps/web/e2e/setup.spec.ts`

**Interfaces:**
- Consumes: маршруты Task 12.
- Produces: страницы по пути `location.pathname` без библиотеки маршрутов: `/setup`, `/login`, `/health`; `/` ведёт на `/setup`, пока `next !== 'done'`, иначе на `/health`. TanStack Query для запросов.
- Токены цветов и шрифтов из `docs/ux/design-system.md` §2, светлая и тёмная тема через `prefers-color-scheme`; ширина от 360 пикселей; видимый фокус.
- Тексты шагов (точные):
  - Шаг 1 «Пароль владельца»: `Пароль нужен, чтобы в пульт входил только ты. Не меньше 10 знаков.` Кнопка `Сохранить пароль`.
  - Шаг 2 «Telegram»: список `1. Открой @BotFather и отправь /newbot.` `2. Придумай имя и адрес бота, адрес должен заканчиваться на bot.` `3. Скопируй токен из ответа и вставь сюда.` Кнопка `Проверить токен`. После успеха: `Бот @{username} найден. Напиши ему /start.` и ожидание с опросом `GET /api/setup/telegram/status` раз в 2 секунды до `bound`.
  - Шаг 3 «Claude»: `На Маке открой Терминал и выполни команду:` блок `claude setup-token` с кнопкой `Скопировать`; `Вставь токен, который она покажет.` Кнопка `Проверить Claude`; во время проверки `Проверяю, это займёт до 30 секунд`.
  - Готово: `Готово. Сара на связи.` и ссылка `Состояние системы`.
  - Ошибки показываются текстом из ответа сервера под полем.
- Playwright: `webServer` поднимает фальшивый Telegram (`tsx tests/fakes/telegramApi.main.ts`), ядро с `SARA_TELEGRAM_API_ROOT=http://localhost:18081`, `SARA_CLAUDE_BIN=tests/fakes/fake-claude.mjs`, `FAKE_CLAUDE_MODE=ok`, `FAKE_CLAUDE_OUTPUT={"ok":true}`, базой `sara_test`, и `vite`.

- [ ] **Step 1: Write the failing test**

```ts
test('FR-SET-1: wizard goes through password, telegram and claude and resumes after reload', async ({ page }) => {
  await page.goto('/'); await page.getByLabel('Пароль').fill('длинныйпароль1'); await page.getByRole('button', { name: 'Сохранить пароль' }).click()
  await page.reload(); await expect(page.getByText('Скопируй токен из ответа')).toBeVisible()
  await page.getByLabel('Токен бота').fill('abc'); await page.getByRole('button', { name: 'Проверить токен' }).click()
  await expect(page.getByText(/@BotFather целиком/)).toBeVisible()
  await page.getByLabel('Токен бота').fill(FAKE_TOKEN); await page.getByRole('button', { name: 'Проверить токен' }).click()
  await controlStart(111); await expect(page.getByText('claude setup-token')).toBeVisible()
  await page.getByLabel('Токен Claude').fill('t'); await page.getByRole('button', { name: 'Проверить Claude' }).click()
  await expect(page.getByText('Готово. Сара на связи.')).toBeVisible()
})
test('FR-UI-3: wizard fits a 360 px screen without horizontal scroll', async ({ page }) => { /* viewport 360 */ })
```

- [ ] **Step 2: Run** `pnpm --filter @sara/web exec playwright test` → FAIL
- [ ] **Step 3: Implement** страницы.
- [ ] **Step 4: Run** → PASS; добавить запуск Playwright в задачу `test` CI.
- [ ] **Step 5: Commit** `feat(web): setup wizard, login and system status pages`

---

### Task 14: Сквозной путь заявки (ST-M0-12)

**Files:**
- Create: `apps/core/src/leads/{pipeline,outbox}.ts`, `apps/core/src/analytics/speed.ts`, `apps/core/src/app.ts`, `apps/core/src/main.ts`
- Test: `tests/e2e/skeleton.test.ts`, `apps/core/test/speed.test.ts`

**Interfaces:**
- Consumes: всё выше: `appendEvent`, `createDeal`, `startDecisionWait`, `deliverDecision`, `setReminderHandler`, `sortOrder`, `Notifier`, `createProfiClient`, `registerProfiEventsRoute`, `getSetting`, `buildServer`.
- Produces:
  - `createLeadPipeline(d: { db: Db; gateway: Gateway; notifier: Notifier; profi: ProfiClient; remindAfterMs: () => Promise<number> }): LeadPipeline` с методами:
    - `onOrderSeen(e: EventEnvelope): Promise<void>`: если заявка с этим `order_id` уже есть, ничего не делать; иначе строка `lead` (`status = 'new'`, `correlation_id` берётся из события `profi.order_seen`, чтобы вся жизнь заявки шла одной цепочкой), событие `lead.found` с `causation_id = e.id`; Сортировщик вызывается с этим `correlationId`; `sortOrder`; успех → `lead.sorted` `{verdict, reason}`; `reject` → `status = 'sorted_out'`, карточки нет; провал Сортировщика → `model.failed` уже записан шлюзом, карточка идёт с `verdict = null`; для `fit`, `maybe` и провала: задача `lead_decision` (`entity = lead`), событие `task.created`, карточка, `startDecisionWait(taskId, remindAfterMs)`, `status = 'queued'`. Обработка одного заказа идёт процессом DBOS с номером `lead:<order_id>`.
    - `onPress(p: { taskId; action }): Promise<string>`: в одной транзакции `UPDATE task SET state='resolved' … WHERE id = $1 AND state = 'open'`; ничего не обновилось → `TEXTS.alreadyDone`; `skip` → `lead.skipped`, `TEXTS.skipped`; `bid` → событие `task.resolved` `{action:'bid'}` (актор `boris`), `deliverDecision`, `enqueueBid`, ответ `TEXTS.bidQueued`.
    - `onReminder(taskId): Promise<void>`: `TEXTS.reminder(title)` и событие `task.reminded`.
  - `enqueueBid(db, i: { leadId: string; accountId: string; text: string; correlationId: string }): Promise<{ outboxId: string; created: boolean }>`: ключ `bid:<order_id>` (номер заказа без аккаунта: два отклика на один заказ невозможны, FR-LEAD-4), событие `outbox.queued`, старт процесса доставки `outbox:<outboxId>`.
  - Процесс доставки: проверить `outbound.bids` (выключено → `bid.failed` `{reason:'paused'}`, `TEXTS.bidsPaused`, конец); `submitBid` с ключом; `UNCERTAIN` → повтор с тем же ключом до 5 раз с паузой 1, 2, 4, 8, 16 секунд (в тестах паузы сокращаются настройкой); успех → в одной транзакции `outbox.confirmed`, `bid.sent` `{spent_rub}`, `spend.recorded`, `lead.status = 'bid_sent'`, `createDeal`; затем `TEXTS.bidSent`. Текст отклика в M0: `Добрый день! Агентство Hance, готовы помочь с задачей «{title}». Расскажите, пожалуйста, подробнее.` (приветствие обязательно).
  - `speedReport(db): Promise<{ leadToCard: Stat; yesToBid: Stat }>`, `Stat = { count: number; p50Ms: number | null; p90Ms: number | null; p95Ms: number | null }`: `leadToCard` это `task.created` минус `lead.found` по `correlation_id`; `yesToBid` это `bid.sent` минус `task.resolved` с `action = 'bid'`. Команда `pnpm report:speed` и маршрут `GET /api/metrics/speed`.
  - `startApp(c: Config, o?: { telegramApiRoot?: string }): Promise<RunningApp>` собирает базу, DBOS, шлюз, бота, клиента Профи, конвейер, сервер; `RunningApp { url; close() }`. `main.ts` вызывает `startApp(loadConfig())`.
- Для сквозного теста `outbound.bids` включается через `setSetting` в начале теста; по умолчанию он выключен.

- [ ] **Step 1: Write the failing tests** (ядро в процессе теста, фальшивые Профи.ру, Telegram и CLI)

```ts
it('FR-LEAD-7: order_seen becomes a lead card in Telegram', async () => {
  await fake.emitOrder(order); await until(() => tg.sent.some(m => m.reply_markup))
  expect(await eventTypes(order)).toEqual(['profi.order_seen','lead.found','model.called','lead.sorted','task.created'])
})
it('FR-LEAD-8: pressing bid sends one bid and confirms in Telegram', async () => {
  tg.pushPress(111, cardData('bid')); await until(() => tg.sent.some(m => m.text?.startsWith('✅ Отклик отправлен')))
  expect(fake.bids).toHaveLength(1); expect(fake.bids[0].text).toMatch(/^Добрый день!/)
  expect(await countEvents('bid.sent')).toBe(1); expect(await dealStage(order)).toBe('bid_sent')
})
it('FR-LEAD-4: two near-simultaneous presses give one bid', async () => {
  tg.pushPress(111, cardData('bid')); tg.pushPress(111, cardData('bid')); await settle()
  expect(fake.bids).toHaveLength(1); expect(tg.answers.map(a => a.text)).toContain('Уже сделано')
})
it('NFR-REL-4: lost acknowledgement after the bid went out does not create a second bid', async () => {
  fake.failNextAck(); tg.pushPress(111, cardData('bid')); await until(() => countEvents('bid.sent'), 1)
  expect(fake.bids).toHaveLength(1)
})
it('FR-LEAD-2: sorter failure still delivers the card', async () => {
  // FAKE_CLAUDE_MODE=exit1
  await fake.emitOrder(order); await until(() => tg.sent.length > 0)
  expect(tg.sent.at(-1).text).toContain('Сортировщик не ответил, проверь сам'); expect(await countEvents('model.failed')).toBe(1)
})
it('FR-LEAD-1: two events with the same order number give one lead and one card', async () => { /* два emitOrder с одним order_id */ })
it('FR-OPS-1: paused bids do not reach Profi', async () => { /* outbound.bids=false: bids пуст, текст bidsPaused */ })
it('G1, G2: speed report has both timings for the passed order', async () => {
  const r = await speedReport(db); expect(r.leadToCard.count).toBe(1); expect(r.yesToBid.count).toBe(1)
})
```

- [ ] **Step 2: Run** `pnpm vitest run tests/e2e/skeleton.test.ts apps/core/test/speed.test.ts` → FAIL
- [ ] **Step 3: Implement** конвейер, исходящую очередь, отчёт скорости, `startApp`, `main.ts`.
- [ ] **Step 4: Run** → PASS
- [ ] **Step 5: Commit** `feat(core): walking skeleton from order to bid with durable outbox`

---

### Task 15: Одна команда для запуска и Claude в контейнере (ST-M0-03, предположение A1)

**Files:**
- Create: `scripts/dev.ts`, `infra/docker/core.Dockerfile`, `scripts/smoke-claude-container.sh`
- Modify: `package.json` (скрипты `dev`, `fake:order`, `probe:claude`, `report:speed`, `smoke:claude-container`), `.env.example`, `README.md` (раздел «Быстрый старт»)

**Interfaces:**
- `pnpm dev`: проверяет `docker info` (нет → `Запусти Docker Desktop и повтори.`), `docker compose -f infra/compose.dev.yml up -d --wait`, `migrate`, запускает три процесса (ядро `tsx watch apps/core/src/main.ts`, фальшивый Профи.ру `tsx apps/profi-node/src/fake/main.ts`, пульт `vite`) с префиксами в выводе, печатает `Пульт: http://localhost:5173`; Ctrl+C останавливает все три.
- `core.Dockerfile`: `node:24-bookworm-slim`, pnpm через corepack, зависимости по lock-файлу, Claude Code CLI той же версии, что на Маке (`claude --version`, сейчас 2.1.308), запуск через `tsx`.
- `smoke-claude-container.sh`: собирает образ, запускает в нём `pnpm probe:claude` с `CLAUDE_CODE_OAUTH_TOKEN` из `.sara/secrets.json`, выходит с кодом 0 только при `ok`.

- [ ] **Step 1: Verify** на чистом клоне: `pnpm install && pnpm dev` → в выводе `Пульт: http://localhost:5173`, мастер открывается.
- [ ] **Step 2: Verify** `pnpm test` целиком быстрее 5 минут (`time pnpm test`).
- [ ] **Step 3: Verify A1** (после шага 6 порядка старта, с токеном Бориса): `pnpm smoke:claude-container` → `ok за N мс`. Итог записать в `docs/product/vision-and-scope.md`, раздел 8, строка A1.
- [ ] **Step 4: Commit** `chore: one-command dev start and claude-in-container smoke`

---

### Task 16: Трассируемость (ST-M0-14)

**Files:**
- Create: `scripts/trace.ts`
- Modify: `.github/workflows/ci.yml` (задача `trace`: `pnpm trace`, отчёт как артефакт; `pnpm trace --strict` на ветках `release-please--*`)
- Test: `scripts/test/trace.test.ts`

**Interfaces:**
- `buildTrace(i: { specMd: string; backlogMd: string; matrixMd: string; testFiles: { path: string; text: string }[] }): { rows: TraceRow[]; unknownIds: string[]; uncovered: string[] }`, `TraceRow = { id: string; milestone: string; stories: string[]; tests: string[] }`.
- Номера требований из спецификации: `| FR-…-N |` и `| NFR-…-N |`; истории из бэклога: заголовки и строки `ST-M…` со строкой «Требования»; вехи из стартовой матрицы `docs/quality/traceability.md`; тесты: номера в первых аргументах `it(`, `test(`, `describe(`.
- `uncovered`: требования, у которых в матрице есть `M0`, и нет ни одного теста. `pnpm trace` пишет `reports/traceability.md`, печатает предупреждения и выходит с 0; с `--strict` выходит с 1, если `uncovered` или `unknownIds` не пусты; `unknownIds` (номер в тесте, которого нет в спецификации) всегда даёт 1.

- [ ] **Step 1: Write the failing tests**

```ts
it('NFR-MAINT-2: maps requirement to stories and tests', () => {
  const r = buildTrace(fixture)
  expect(r.rows.find(x => x.id === 'FR-SET-1')).toEqual({ id: 'FR-SET-1', milestone: 'M0', stories: ['ST-M0-10'], tests: ['apps/core/test/setup.test.ts'] })
})
it('NFR-MAINT-2: unknown id in a test is reported', () => { expect(buildTrace(withBadId).unknownIds).toEqual(['FR-NOPE-1']) })
it('NFR-MAINT-2: M0 requirement without a test is uncovered', () => { expect(buildTrace(fixture).uncovered).toContain('FR-MIND-1') })
```

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS; `pnpm trace` на репозитории печатает отчёт.
- [ ] **Step 5: Commit** `feat: requirements traceability report in CI`

---

### Task 17: Каркас разума и его проверка (ST-M0-15, C6)

**Files:**
- Create: `scripts/mind-check.ts`, `scripts/test/mind-check.test.ts`, фикстуры `scripts/test/fixtures/mind/{good,bad}/`
- В репозитории `sara-mind` (клон в `~/sara-mind`): `mind/shared/knowledge/.gitkeep`, `mind/shared/understanding/.gitkeep`, `mind/shared/speech/examples/.gitkeep`, `mind/shared/judgment/.gitkeep`, `mind/directions/.gitkeep`, `mind/proposals/.gitkeep`, `README.md` (что где лежит, правило «изменения только после «да» Бориса»)

**Interfaces:**
- Consumes: `MindFrontmatter` (Task 3).
- Produces: `checkMind(root: string): Promise<{ file: string; field: string; message: string }[]>`; читает `*.md` под `root`, разбирает поля сверху пакетом `yaml`, проверяет `MindFrontmatter`; файл без полей сверху это ошибка поля `frontmatter`. Команда `pnpm mind:check <путь>` выходит с 1 при ошибках.

- [ ] **Step 1: Write the failing tests**

```ts
it('FR-MIND-1: valid record passes', async () => { expect(await checkMind(goodDir)).toEqual([]) })
it('FR-MIND-1: wrong status names the file and the field', async () => {
  expect(await checkMind(badDir)).toEqual([{ file: join(badDir, 'price.md'), field: 'status', message: expect.any(String) }])
})
```

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS
- [ ] **Step 5:** `gh repo clone natadvn-hance/sara-mind ~/sara-mind`, добавить папки и README, `pnpm mind:check ~/sara-mind/mind` → без ошибок, коммит `chore: mind skeleton` и push в `sara-mind`.
- [ ] **Step 6: Commit** (в `sara`) `feat: mind frontmatter check`

---

### Task 18: Приёмка M0

**Files:**
- Modify: `docs/quality/acceptance/M0.md` (команды для Сары в шагах 1, 8, 10, 11: `pnpm dev`, `pnpm fake:order`, `pnpm report:speed`, тест убийства процесса), `docs/handoff/` (новое состояние), `docs/product/vision-and-scope.md` (A1)

- [ ] **Step 1: Verify** `pnpm check && pnpm test && pnpm trace --strict` → зелёное, покрытие требований M0 полное.
- [ ] **Step 2: Verify** с Борисом по чек-листу `docs/quality/acceptance/M0.md`: бот для разработки (настоящий Telegram) и токен Claude Бориса; все 12 шагов прошли.
- [ ] **Step 3:** Написать документ передачи дел `docs/handoff/<дата>-m0-done.md`; слить пул-реквест выпуска release-please; отправить Борису «Что нового» по шаблону `docs/templates/release-notes.md`.
- [ ] **Step 4: Commit** `docs: M0 accepted`

---

## Self-review

- **Покрытие историй:** ST-M0-01 → Task 1; 02 → Task 2; 03 → Tasks 4, 15; 04 → Task 5; 05 → Task 6; 06 → Task 8; 07 → Task 9; 08 → Task 10; 09 → Task 11; 10 → Tasks 12, 13; 11 → Tasks 12, 13; 12 → Task 14; 13 → Tasks 1, 2, 7; 14 → Task 16; 15 → Task 17; 16 → Task 2. Чек-лист приёмки → Task 18.
- **Требования M0 из стартовой матрицы:** FR-SET-1, 2, 3, 5; FR-LEAD-2, 7, 8; FR-NOTIF-1; FR-UI-3; FR-OPS-4; FR-MIND-1 (каркас): у каждого есть тест с номером в задачах выше.
- **Совпадение имён:** `appendEvent`/`appendEventIfNew` (Task 5) используются в Tasks 6, 7, 10, 11, 14; `Gateway.call` (Task 8) в Tasks 9, 12; `ProfiClient.submitBid` (Task 10) в Task 14; `Notifier` и `TEXTS` (Task 11) в Task 14; `startDecisionWait`/`deliverDecision` (Task 6) в Task 14.
- **Отложено осознанно:** приоритеты шлюза P0-P3, обезличивание (ST-M2-02), правила денег, проверка экраном, настоящий Профи-MCP: вехи M1-M2.
