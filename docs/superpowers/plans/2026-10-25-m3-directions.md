# M3 «Направления»: план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Борис настраивает и правит направление в пульте словами (8 шагов с «Правильно понимаю?»), проверяет его на 20 настоящих заявках и на последних 50, хранит формат отклика и кейсы, которые читает Аналитик, а маршрутизатор отдаёт каждую заявку одному направлению и не пускает второй отклик.

**Architecture:** Правила оценки остаются в `core.direction_version` и меняются только через `addVersion`. Рядом новые таблицы: профиль направления, черновик онбординга, прогоны (калибровка, пересчёт) с кешем пробных оценок, кандидаты и маршрут заявки. Новая роль Claude `onboarding` (одна роль, схема ответа своя на шаг). Пробные оценки идут фоном с приоритетом P3. В пульте новые страницы по существующим компонентам.

**Tech Stack:** TypeScript, Fastify, Drizzle (Postgres), zod, vitest (ядро), React 19 + TanStack Query + Tailwind (пульт), Playwright (e2e), поддельный CLI `tests/fakes/fake-claude.mjs`.

**Spec:** `docs/superpowers/specs/2026-10-25-m3-directions-design.md` (разделы указаны в задачах), плюс `docs/superpowers/specs/2026-10-24-direction-scoring-design.md`, дизайн v3 раздел 9, FR-ACC-2..5, FR-LEAD-4, FR-LEAD-6 в `docs/spec/2026-10-22-sara-spec-v1.md`.

## Global Constraints

- Все тексты для Бориса по-русски, простым языком, **без длинного тире и среднего тире** (`pnpm check` ищет U+2014; U+2013 тоже не писать). Вместо них запятая, точка, двоеточие, короткий дефис.
- Правила оценки меняются только через `addVersion` (`apps/core/src/direction/store.ts`), `createdBy: 'boris'`. Строки `core.direction_version` никогда не обновляются и не удаляются новым кодом, кроме флага `active`, который уже ставит `insertVersion`.
- Тесты называются с номером требования: `it('FR-ACC-3: …')`. Фразы требований: FR-ACC-2 (направление и профиль), FR-ACC-3 (онбординг), FR-ACC-4 (калибровка), FR-ACC-5 (пересчёт), FR-LEAD-4 (маршрутизатор), FR-LEAD-6 (отклик), FR-UI-3 (состояния, 360 px, темы), FR-UI-5 («почему так»), FR-MIND-3 (откат).
- Тесты первыми: падающий тест, увидеть падение, потом код. Живая модель в тестах и CI не вызывается (`FAKE_CLAUDE_OUTPUT_BY_ROLE`).
- Свой Postgres: `DATABASE_URL=postgres://sara:sara@localhost:54363/sara pnpm test`, затем `pnpm check`. Контейнер `sara-pg-m3`, в конце убрать. Контейнеры Plane и сервер не трогать.
- `WORKFLOW_VERSION` не менять. Новые шаги в `processOrder` только за `DBOS.patch('<имя>')`.
- Файлы соседних сессий (`apps/core/src/leads/pipeline.ts`, `apps/core/src/notify/`, `apps/profi-node`, модуль разговора M4) менять только там, где задача прямо это называет (задачи 18 и 22), минимально.
- Модель получает заказы без имени клиента (то, что уже делает `sorterInput` и шлюз). Слова Бориса в журнал событий не пишутся (только номер шага и размеры).
- Коммиты по Conventional Commits на английском; в конце сообщения строка `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`. В `main` только через PR с зелёным CI. Перед каждым PR `git fetch` и перенос на свежий `origin/main`; свои миграции пересоздать, если в `main` появился тот же номер.
- Каждый PR: зелёный CI, один свежий проверяющий на самой сильной модели (opus), Critical и Important чинятся тестами, которые сначала падали; ссылка отправляется главной сессии `local_9f09fba9-887f-4d0c-bacf-2a12bd5765ad`. PR не сливать.
- Пульт: существующие `tokens.css` и компоненты `Card`, `Button`, `Input`; светлая и тёмная тема; ширина от 360 px без горизонтальной прокрутки; у каждого экрана «загрузка», «пусто», «ошибка».

## Review Focus

1. Правила изменились, пока Борис настраивал (принято предложение поправки, откат): «Включить» не должно молча затереть новую версию. Тест в задаче 7.
2. Два нажатия «Включить» (двойной клик, два окна): ровно одна новая версия. Тест в задаче 7.
3. Модель вернула ответ не по схеме, веса не в сумме 100 или упала посреди шага: черновик цел, шаг можно повторить. Тест в задаче 6.
4. Перезагрузка страницы калибровки не меняет выборку и не теряет отметки; повторная отметка той же заявки заменяет прежнюю. Тест в задаче 13.
5. Лимит Claude во время пересчёта: прогон останавливается с понятной причиной, живые карточки не ждут. Тест в задаче 10.
6. Кейс с чужим id, ссылкой не `https://`, отклик на 499 знаков: ссылки не вставляются, текст не режется. Тест в задаче 17.
7. Параллельные нажатия «Откликнуться» из карточек двух аккаунтов на один заказ: одна запись в outbox. Тест в задаче 22.

---

## PR 1. Дизайн и план (docs)

### Task 1: Документы

**Files:**
- Create: `docs/superpowers/specs/2026-10-25-m3-directions-design.md`, `docs/superpowers/plans/2026-10-25-m3-directions.md`

- [ ] **Step 1:** Написаны этот план и дизайн; в них нет U+2014 и U+2013 (`grep -nP "[\x{2013}\x{2014}]" docs/superpowers/*/2026-10-25-*`, пусто).
- [ ] **Step 2:** `pnpm check` зелёный.
- [ ] **Step 3:** Проверяющий (opus) читает дизайн против кода и находит противоречия; правки внесены.
- [ ] **Step 4:** Коммит `docs: M3 directions design and plan`, PR, ссылка главной сессии.

---

## PR 2. Профиль, карточка направления, версии и откат (FR-ACC-2, FR-MIND-3, FR-UI-3)

### Task 2: Контракты профиля и события

**Files:**
- Modify: `packages/shared/src/contracts/direction.ts`, `packages/shared/src/contracts/eventTypes.ts`, `packages/shared/src/index.ts` (если экспорт нужен)
- Test: `apps/core/test/direction/contracts.test.ts`

**Interfaces:**
- Produces (в `@sara/shared`):
  - `ReplyFormat = { parts: {id:string; title:string; hint:string}[]; max_chars: number /*1..500*/; tone: string[]; examples: string[] /*до 3*/; max_cases: number /*0..3*/ }`
  - `DirectionCase = { id: string /*^[a-z0-9_]+$*/; title: string; url: string /*https://*/; summary: string; tags: string[]; show_when: string; never_when: string | null }`
  - `DirectionProfileData = { speed: 'normal'|'fast'; reply_format: ReplyFormat | null; cases: DirectionCase[] /*до 30, уникальные id*/ }`
  - `DirectionState = 'draft'|'shadow'|'on'`
  - новые `EVENT_TYPES`: `direction.onboarding_started`, `direction.step_confirmed`, `direction.onboarding_finished`, `direction.profile_changed`, `direction.run_finished`, `lead.routed`.

- [ ] **Step 1: Failing test** `FR-ACC-2: a case needs an https link and a unique id` (http-ссылка отвергается, повтор id отвергается, 31 кейс отвергается), `FR-ACC-2: the reply format keeps 500 characters at most and 3 cases at most`.
- [ ] **Step 2:** Запустить `pnpm vitest run apps/core/test/direction/contracts.test.ts`; ждём падение (нет схем).
- [ ] **Step 3:** Схемы zod в `direction.ts`, события в `eventTypes.ts`.
- [ ] **Step 4:** Тест зелёный. **Step 5:** Коммит `feat(shared): the direction profile contract and its journal events`.

### Task 3: Таблица профиля и его хранилище

**Files:**
- Modify: `apps/core/src/db/schema.ts` (`directionProfile`), `apps/core/src/app.ts` (после `seedDirection` вызвать `seedProfile`)
- Create: `apps/core/src/direction/profile.ts`, миграция `apps/core/drizzle/0008_direction_profile.sql` (`pnpm --filter @sara/core exec drizzle-kit generate --name direction_profile`)
- Test: `apps/core/test/direction/profile.test.ts`

**Interfaces:**
- Produces:
  - `DEFAULT_REPLY_FORMAT: ReplyFormat` (то, что сегодня в роли Аналитика: части `understanding`, `question`; `max_chars: 500`; `tone` пусто; `examples` пусто; `max_cases: 0`).
  - `getProfile(db: Db | Tx, accountId: string): Promise<{ state: DirectionState; version: number } & DirectionProfileData>`; нет строки: `{state:'on', version:0, speed:'normal', reply_format:null, cases:[]}`.
  - `seedProfile(db: Db, accountId: string): Promise<void>`: создаёт строку `on` один раз, не трогает существующую.
  - `saveProfile(db: Db, accountId: string, patch: Partial<DirectionProfileData & {state: DirectionState}>, actor: 'boris'|'system'): Promise<number>` (проверяет схемами, растит `version` на 1 под консультативной блокировкой `direction_profile:<acc>`, пишет событие `direction.profile_changed` с номером версии и ключами, без текстов).

- [ ] **Step 1: Failing tests** `FR-ACC-2: the profile is created once and never overwritten by a restart`; `FR-ACC-2: saving the profile grows its version and journals the change without the texts`; `FR-ACC-2: two saves at once give two versions in order` (две параллельные `saveProfile`, версии 1 и 2).
- [ ] **Step 2:** запустить, падение (нет таблицы). **Step 3:** таблица, миграция, `profile.ts`. **Step 4:** зелёные, `pnpm vitest run apps/core/test/db/schema.test.ts` тоже. **Step 5:** коммит `feat(core): direction profile table and store`.

### Task 4: API карточки направления и отката

**Files:**
- Create: `apps/core/src/direction/routes.ts` (`registerDirectionRoutes(app, d)`), подключить в `apps/core/src/api/server.ts`
- Test: `apps/core/test/direction/routes.test.ts`

**Interfaces:**
- Produces HTTP (за `requireSession`, аккаунт должен быть в `d.accounts`, иначе 404 `{error:'Такого аккаунта нет.'}`):
  - `GET /api/directions/:accountId` → `{ account:{id,title}, state, active:{version,rules}, versions:[{version,createdAt,createdBy,reason,active}], profile:{speed,reply_format,cases,version}, onboarding: null | {open:true; step:number} }`
  - `POST /api/directions/:accountId/rollback` `{version:number}` → `{version:number}` через `rollbackTo`; неизвестная версия: 404 `{error:'Такой версии нет.'}`.

- [ ] **Step 1: Failing tests** (`buildTestApp`, вход по паролю как в `accounts.test.ts`): `FR-ACC-2: the direction page data has the active rules, the versions and the profile`; `FR-MIND-3: rollback adds a new version with the old rules and leaves the history`; `FR-ACC-2: an unknown account is a 404`; `FR-ACC-2: without a session the direction is 401`.
- [ ] **Step 2:** падение. **Step 3:** маршруты. **Step 4:** зелёные. **Step 5:** коммит `feat(core): direction page API and rollback`.

### Task 5: Страница «Направление» в пульте

**Files:**
- Create: `apps/web/src/pages/Direction.tsx`, `apps/web/src/components/ui/badge.tsx` (если нужен для состояния)
- Modify: `apps/web/src/App.tsx` (маршрут `/accounts/:id/direction`), `apps/web/src/pages/Accounts.tsx` (ссылка «Направление»), `apps/web/src/api.ts` (типы `DirectionView`)
- Test: `apps/web/e2e/direction.spec.ts`

**Interfaces:**
- Consumes: HTTP из задачи 4. Produces: компонент `DirectionPage({accountId})`, список версий с кнопкой «Вернуть эту версию» (подтверждение «Вернуть v2? Старые версии останутся.»).

- [ ] **Step 1: Failing e2e** `FR-ACC-2: the direction page shows the rules, the versions and rolls back` (вход, открыть `/accounts/hance-marketing/direction`, видеть «Правила v1», пять осей с весами, порог; «Вернуть эту версию» у не действующей версии даёт «Теперь действуют правила v3»); `FR-UI-3: the direction page fits 360 px in both themes` (`page.emulateMedia({colorScheme})`, нет горизонтальной прокрутки, контраст текста не проверяем); `FR-UI-3: the direction page shows a loading and an error state` (маршрут API подменён на 500: «Не получилось загрузить. Попробуй ещё раз.» и кнопка «Повторить»).
- [ ] **Step 2:** `pnpm --filter @sara/web e2e -g "direction"`; падение. **Step 3:** страница по образцу `Accounts.tsx`. **Step 4:** зелёные. **Step 5:** коммит `feat(web): the direction page with versions and rollback`.
- [ ] **Step 6:** проверяющий, PR 2.

---

## PR 3. Онбординг, шаги 1-3 (FR-ACC-3)

### Task 6: Роль `onboarding` и сборка шага

**Files:**
- Create: `roles/onboarding/meta.json` (`name onboarding`, `version 1`, `model sonnet`, `fallbackModel opus`, `priority P1`, `timeoutMs 120000`), `roles/onboarding/role.md`, `packages/shared/src/contracts/onboarding.ts`, `apps/core/src/direction/onboarding.ts`
- Modify: `apps/core/src/gateway/roles.ts` (`RoleName` + `'onboarding'`), `packages/shared/src/index.ts`
- Test: `apps/core/test/direction/onboarding.test.ts`

**Interfaces:**
- Produces (`@sara/shared`): `OnbAbout = {understood:string; about:string; services:string[]; clients:string[]; budgets:string[]}`; `OnbStops = {understood:string; stop_factors: DirectionRules['stop_factors']; red_flags: DirectionRules['red_flags']}`; `OnbIdeal = {understood:string; axes: DirectionRules['axes']; threshold:number; notes:string[]}`; `OnboardingDraft` (см. задачу 7).
- Produces (`onboarding.ts`): `proposeStep(d: {gateway: Gateway}, step: 1|2|3, input: {say: string; fix?: string; previous?: unknown; confirmed: ConfirmedSoFar; current: DirectionRules | null}): Promise<{ok:true; understood:string; data: unknown} | {ok:false; reason:'no_answer'|'invalid'}>`. После ответа проверяет схему шага; для шага 3 собирает `DirectionRules` и проверяет её; при ошибке один раз зовёт роль снова с названием ошибки в тексте.

- [ ] **Step 1: Failing tests** (поддельный CLI): `FR-ACC-3: step 1 returns the understanding and the structured about`; `FR-ACC-3: step 3 axes that do not add up to 100 are asked once more with the error`; `FR-ACC-3: a second invalid answer is a miss, not a crash`; `FR-ACC-3: a model failure is a miss`; `FR-ACC-3: Boris's correction and the previous attempt go into the next call` (в логе `FAKE_CLAUDE_ARGS_LOG` stdin содержит поправку и прошлое «Я поняла так»).
- [ ] **Step 2:** падение. **Step 3:** роль: `role.md` по-русски, объясняет шаги, требует поле `understood` простым языком 2-6 строк без длинного тире и не выдумывать фактов; `proposeStep`. **Step 4:** зелёные. **Step 5:** коммит `feat(core): the onboarding role and step proposals`.

### Task 7: Черновик, подтверждение шагов и «Включить»

**Files:**
- Modify: `apps/core/src/db/schema.ts` (`directionOnboarding`), `apps/core/src/direction/routes.ts`, `apps/core/src/direction/onboarding.ts`
- Create: миграция `0009_direction_onboarding.sql`
- Test: `apps/core/test/direction/onboardingFlow.test.ts`

**Interfaces:**
- Produces: таблица `core.direction_onboarding(account_id pk, mode 'new'|'edit', based_on_version int|null, draft jsonb, state 'open'|'finished'|'cancelled', started_at, updated_at)`. Одна строка на аккаунт: новый запуск после `finished`/`cancelled` перезаписывает её.
- `OnboardingDraft = { steps: Record<'1'|'2'|'3'|'5'|'6'|'7', {say:string; proposal:{understood:string; data:unknown; attempts:number} | null; confirmed: unknown | null; skipped: boolean}>; }`
- `startOnboarding(db, accountId, mode): Promise<OnboardingView>` (открытый возвращает как есть); `submitStep(d, accountId, step, {say, fix?}): Promise<OnboardingView>`; `confirmStep(db, accountId, step): Promise<OnboardingView>`; `skipStep`; `cancelOnboarding`; `assembleRules(base: DirectionRules | null, draft): DirectionRules` (подтверждённые шаги заменяют свои разделы; режим «новое» без шагов 1-3 не собирается); `finishOnboarding(d, accountId, opts: {override?: {reason: string}}): Promise<{version:number} | {version:null; unchanged:true} | {error:'stale'|'incomplete'|'needs_calibration'}>`.
- HTTP: `GET/POST /api/directions/:accountId/onboarding`, `POST …/onboarding/steps/:n` `{say, fix?}`, `POST …/onboarding/steps/:n/confirm`, `POST …/onboarding/steps/:n/skip`, `POST …/onboarding/finish` `{override?:{reason}}`, `POST …/onboarding/cancel`. `OnboardingView = {mode, step, basedOn, steps:{…}, rules: DirectionRules|null}`; ошибка `stale` 409 `{error:'Правила изменились, пока ты настраивал. Обнови черновик.', code:'stale'}`.

- [ ] **Step 1: Failing tests:** `FR-ACC-3: the draft is saved at every step and survives a reload`; `FR-ACC-3: "Нет, поправить" keeps the earlier attempts`; `FR-ACC-3: finishing makes one new version through addVersion and leaves every old row as it was` (снимок `direction_version` до и после: старые строки равны, кроме `active`); `FR-ACC-3: finishing with rules equal to the active ones makes no version`; `FR-ACC-3: edit mode takes unconfirmed sections from the active rules`; `FR-ACC-3: two finishes at once give one version` (Review Focus 2); `FR-ACC-3: rules changed meanwhile make finishing a 409 stale, and refreshing the draft keeps the confirmed steps` (Review Focus 1, `rules.applied`-подобная вторая версия между стартом и finish); `FR-ACC-3: a model miss leaves the draft unchanged` (Review Focus 3); `FR-ACC-3: changed rules without a calibration need an override with a reason, which the journal keeps` (до PR 5 `needs_calibration` всегда, пока нет прогона; override проходит и пишет `direction.onboarding_finished` с `reason`).
- [ ] **Step 2:** падение. **Step 3:** таблица, миграция, функции, маршруты. `finishOnboarding` в транзакции под `pg_advisory_xact_lock(hashtext('direction:<acc>'))` (тот же ключ, что в `insertVersion`), проверка `based_on_version === active.version` внутри транзакции. **Step 4:** зелёные. **Step 5:** коммит `feat(core): onboarding draft, steps 1-3 and finishing through addVersion`.

### Task 8: Мастер в пульте

**Files:**
- Create: `apps/web/src/pages/Onboarding.tsx`, `apps/web/src/components/ui/textarea.tsx`, `apps/web/src/components/ui/stepper.tsx`
- Modify: `apps/web/src/App.tsx` (`/accounts/:id/direction/onboarding`), `apps/web/src/pages/Direction.tsx` (кнопка «Изменить с Claude»), `apps/web/e2e/direction.spec.ts`

**Interfaces:**
- Consumes: HTTP задачи 7. Шаги 4-8 в полоске видны, но неактивны с подписью «скоро» (включаются в PR 5 и 6).

- [ ] **Step 1: Failing e2e:** `FR-ACC-3: Boris says step 1, sees "Я поняла так" and presses "Да, правильно"` (поддельный Claude отвечает по роли `onboarding`); `FR-ACC-3: "Нет, поправить" asks what is wrong and shows the new understanding`; `FR-ACC-3: reload returns to the same step with the saved text`; `FR-UI-3: the wizard fits 360 px in both themes`; `FR-UI-3: a failed model call shows "Не получилось, попробуй сказать иначе" and keeps the text in the field`.
- [ ] **Step 2:** падение. **Step 3:** мастер: поле, «Отправить», блок «Я поняла так:», «Правильно понимаю?», «Да, правильно», «Нет, поправить», раскрывающееся «Как это запишется», «Назад», «Пропустить» (только режим правки). **Step 4:** зелёные. **Step 5:** коммит `feat(web): the direction onboarding wizard, steps 1-3`.
- [ ] **Step 6:** проверяющий, PR 3.

---

## PR 4. Пересчёт на последних 50 заявках (FR-ACC-5)

### Task 9: Пробные оценки с кешем и приоритет шлюза

**Files:**
- Modify: `apps/core/src/db/schema.ts` (`trialScore`), `apps/core/src/gateway/gateway.ts` (`CallOptions.priority?: Priority`, используется вместо `meta.priority` для очереди и записи), `apps/core/src/leads/scorer.ts` (`scoreOrder` принимает `priority` в `opts` и передаёт шлюзу)
- Create: `apps/core/src/direction/trial.ts`, миграция `0010_trial_score.sql`
- Test: `apps/core/test/direction/trial.test.ts`, `apps/core/test/gateway.test.ts` (дополнить)

**Interfaces:**
- Produces: `rulesHash(rules: DirectionRules): string` (sha256 от канонического JSON с отсортированными ключами); `orderOfLead(row): ProfiOrder` (вынести из `learning/backtest.ts`, тот файл начинает им пользоваться); `trialScore(d: {db, gateway}, accountId: string, leadId: string, rules: DirectionRules, mode: 'plain'|'escalated'): Promise<TrialResult | null>` с кешем по `(rules_hash, lead_id, mode)`; `TrialResult = {score:number; decision:'show'|'drop'; stopFactor:string|null; redFlags:string[]; axes; reason:string; confidence:number; model:'haiku'|'sonnet'}`. `plain` = `scoreOrder(…, {escalate:false})`, `escalated` = как в работе.

- [ ] **Step 1: Failing tests:** `FR-ACC-5: the same rules in another key order have the same hash`; `FR-ACC-5: a second trial of the same lead and rules does not call the model` (счётчик вызовов в логе CLI); `FR-ACC-5: a trial with a priority override is queued as P3 behind a waiting P1` (gateway.test: concurrency 1); `FR-ACC-5: a model miss is not cached`.
- [ ] **Step 2:** падение. **Step 3:** реализация; `model_call.priority` пишет эффективный приоритет. **Step 4:** зелёные, старые тесты `backtest` и шлюза тоже. **Step 5:** коммит `feat(core): cached trial scores and a priority override for gateway calls`.

### Task 10: Прогоны и фоновый исполнитель

**Files:**
- Modify: `apps/core/src/db/schema.ts` (`directionRun`)
- Create: `apps/core/src/direction/runs.ts`, миграция `0011_direction_run.sql`
- Test: `apps/core/test/direction/runs.test.ts`

**Interfaces:**
- Produces: таблица `core.direction_run(id uuid pk, account_id, kind 'recompute'|'calibration', rules jsonb, rules_hash, base_hash text|null, seed int, state 'queued'|'running'|'marking'|'done'|'stopped'|'failed', total int, done int, stop_reason text|null, result jsonb|null, created_at, finished_at)`; `createRun(db, {accountId, kind, rules, baseRules}): Promise<string>`; `runWorker(d, runId): Promise<void>` (по одному вызову одновременно, обновляет `done` после каждой заявки, останавливается с `stopped` и `stop_reason` при `limit_reached`); `resumeRuns(d): Promise<void>` (в `app.ts`: прогоны `running` продолжаются, оценки из кеша не повторяются); `getRun(db, id)`.

- [ ] **Step 1: Failing tests:** `FR-ACC-5: a run counts its progress as leads are scored`; `FR-ACC-5: a restart continues a running run without scoring the finished leads again`; `FR-ACC-5: the Claude limit stops the run with a reason and no waiting` (Review Focus 5: поддельный CLI в режиме `limit`, прогон `stopped`, живой вызов P1 в это время получает слот); `FR-ACC-5: a run is journaled when it ends` (`direction.run_finished`).
- [ ] **Step 2-5:** падение, реализация (вызовы идут через `withoutLimitWait(gateway)` и `priority: 'P3'`), зелёные, коммит `feat(core): background direction runs that survive a restart`.

### Task 11: Пересчёт: пул, сравнение и API

**Files:**
- Create: `apps/core/src/direction/recompute.ts`
- Modify: `apps/core/src/direction/routes.ts`, `apps/core/src/app.ts` (`resumeRuns`)
- Test: `apps/core/test/direction/recompute.test.ts`

**Interfaces:**
- Produces: `recomputePool(db, accountId, n = 50): Promise<LeadRow[]>` (последние n заявок аккаунта с живой оценкой `backtest = false`, новые сверху); `compareRun(db, runId): Promise<RecomputeResult>`, `RecomputeResult = {checked:number; changed:number; toDrop:number; toShow:number; agreementBefore:number|null; agreementAfter:number|null; items:{leadId,title,city,before:{score,decision}, after:{score,decision,reason,axes,stopFactor}, boris:'yes'|'no'|null}[]}` (`items` только с изменившимся решением; `boris` из `lead_label` или `calibration_item`); HTTP `POST /api/directions/:accountId/runs` `{kind:'recompute', rules:'draft'|'active'|{version:number}}` → `{id}`, `GET /api/directions/:accountId/runs/:runId` → `{id,kind,state,total,done,stop_reason,result|null}`.

- [ ] **Step 1: Failing tests:** `FR-ACC-5: the last 50 scored leads are the pool, fewer are all of them`; `FR-ACC-5: the result lists only leads whose decision changed, with scores before and after`; `FR-ACC-5: before and after are scored on the same model` (оба `haiku`, в логе нет `sonnet`); `FR-ACC-5: Boris's marks show next to the changed leads and the agreement before and after`; `FR-ACC-5: sorted-out and stale leads are not in the pool`; `FR-ACC-5: starting a recompute returns at once and the run finishes in the background`.
- [ ] **Step 2-5:** падение, реализация, зелёные, коммит `feat(core): recompute on the last 50 leads`.

### Task 12: Экран пересчёта

**Files:**
- Create: `apps/web/src/pages/Recompute.tsx`, `apps/web/src/components/ui/progress.tsx`, `apps/web/src/components/ui/whybox.tsx` («Почему так»: раскрывающееся с осями и причиной, FR-UI-5)
- Modify: `apps/web/src/App.tsx` (`…/direction/recompute`), `Direction.tsx` и `Onboarding.tsx` (кнопка «Пересчитать на последних 50 заявках»)
- Test: `apps/web/e2e/direction.spec.ts`

- [ ] **Step 1: Failing e2e:** `FR-ACC-5: Boris starts a recompute, sees "28 из 50" and then the changed leads`; `FR-UI-5: a changed lead opens "Почему так" with the axes`; `FR-ACC-5: the Claude limit shows "Подожди, лимит Claude" and no endless spinner`; `FR-UI-3: the recompute screen fits 360 px in both themes and has an empty state` («Заявок для проверки пока нет»).
- [ ] **Step 2-5:** падение, экран с опросом раз в 2 секунды (`refetchInterval` пока `state` не `done`/`stopped`/`failed`), зелёные, коммит `feat(web): the recompute screen`.
- [ ] **Step 6:** проверяющий, PR 4.

---

## PR 5. Калибровка и включение (FR-ACC-4)

### Task 13: Выборка и отметки

**Files:**
- Modify: `apps/core/src/db/schema.ts` (`calibrationItem`)
- Create: `apps/core/src/direction/calibration.ts`, миграция `0012_calibration_item.sql`
- Test: `apps/core/test/direction/calibration.test.ts`

**Interfaces:**
- Produces: `core.calibration_item(run_id uuid, lead_id text, position int, mark 'yes'|'no'|'unsure'|null, marked_at, pk(run_id, lead_id))`; `startCalibration(db, {accountId, rules, seed?}): Promise<{runId:string; total:number} | {error:'too_few'; have:number}>`; выборка `calibrationSample(db, accountId, seed, size = 20): Promise<LeadRow[]>`; `markItem(db, runId, leadId, mark): Promise<{marked:number; total:number}>`.

- [ ] **Step 1: Failing tests:** `FR-ACC-4: the sample is 20 leads: 8 near the threshold, 6 above, 6 below`; `FR-ACC-4: leads Boris already decided on, sorted-out and stale leads are not in it`; `FR-ACC-4: the same seed gives the same sample after a reload` (Review Focus 4); `FR-ACC-4: marking the same lead again replaces the mark`; `FR-ACC-4: fewer than 10 leads is "too_few" with the number there are`; `FR-ACC-4: the sample stays in the run so a reload does not change it`.
- [ ] **Step 2-5:** падение, реализация (детерминированное перемешивание по `seed`: сортировка по `sha256(seed + lead_id)`), зелёные, коммит `feat(core): the calibration sample and Boris's marks`.

### Task 14: Согласие, расхождения и пороговая подсказка

**Files:**
- Modify: `apps/core/src/direction/calibration.ts`, `apps/core/src/direction/runs.ts` (калибровка после последней отметки ставит оценки в фон)
- Test: `apps/core/test/direction/calibration.test.ts`

**Interfaces:**
- Produces: `CALIBRATION_TARGET = 0.85`, `MIN_DECISIVE = 15`; `calibrationResult(db, runId): Promise<CalibrationResult>`, `CalibrationResult = {decisive:number; unsure:number; agreement:number|null; passed:boolean; reliable:boolean; misses:{leadId,title,city,text,kind:'sara_yes_boris_no'|'sara_no_boris_yes',score,reason,axes,stopFactor,redFlags,note:string|null}[]; thresholdHint:{from:number; to:number; before:number; after:number}|null}` (`sara_no_boris_yes` первыми); `setNote(db, runId, leadId, note)`; `thresholdHint` считается по 20 пробным оценкам (режим `escalated`): перебор порога 0..100, предложение, если выигрыш согласия не меньше 0,10.

- [ ] **Step 1: Failing tests:** `FR-ACC-4: agreement counts yes and no only, "не знаю" is out of it`; `FR-ACC-4: fewer than 15 decisive marks is not reliable and not passed`; `FR-ACC-4: 17 of 20 agreeing passes the 85% target`; `FR-ACC-4: lost leads are listed before extra ones`; `FR-ACC-4: the threshold hint appears for a 10 point gain and not below`; `FR-ACC-4: the score is not shown while marking` (ответ API отметок не содержит балла и решения).
- [ ] **Step 2-5:** падение, реализация, зелёные, коммит `feat(core): calibration agreement, misses and a threshold hint`.

### Task 15: Предложение поправки и проверка включения

**Files:**
- Create: `apps/core/src/direction/advice.ts`
- Modify: `apps/core/src/direction/onboarding.ts` (`finishOnboarding` читает согласие), `apps/core/src/direction/routes.ts`
- Test: `apps/core/test/direction/advice.test.ts`

**Interfaces:**
- Produces: `adviseRules(d, runId): Promise<{ok:true; summary:string; why:string; lines:string[]; rules:DirectionRules; agreementAfter:number|null} | {ok:false; reason:'not_one_change'|'invalid'|'no_answer'}>` (роль `rules-proposer`, вход из расхождений и причин Бориса, `rulesDiff` ровно один раздел, пересчёт 20 заявок по новым правилам); `applyAdviceToDraft(db, accountId, rules)`; в `finishOnboarding`: если правила изменились, нужен прогон калибровки с `rules_hash` равным хешу собранных правил, `passed` (или `override`).
- HTTP: `POST /api/directions/:accountId/runs` `{kind:'calibration', rules}` → `{id}`; `POST …/runs/:runId/marks` `{lead_id, mark, note?}` → `{marked, total}`; `GET …/runs/:runId` (для калибровки отдаёт `CalibrationResult` после `done`); `POST …/runs/:runId/advice` → предложение; `POST …/runs/:runId/advice/apply` → черновик обновлён.

- [ ] **Step 1: Failing tests:** `FR-ACC-4: an advice with two changes is thrown away`; `FR-ACC-4: an advice shows the agreement it would give on the same 20 leads`; `FR-ACC-4: applying an advice changes the draft and makes no version`; `FR-ACC-4: finishing changed rules needs a passed calibration on exactly those rules`; `FR-ACC-4: the same rules with another threshold need a new calibration`; `FR-ACC-4: below 85% only an override with a reason saves, and the journal has it`.
- [ ] **Step 2-5:** падение, реализация, зелёные, коммит `feat(core): calibration advice and the 85% gate for finishing`.

### Task 16: Экран калибровки и шаги 4 и 8

**Files:**
- Create: `apps/web/src/pages/Calibration.tsx`
- Modify: `apps/web/src/App.tsx` (`…/direction/calibration`), `apps/web/src/pages/Onboarding.tsx` (шаги 4 и 8 активны: шаг 8 показывает согласие, «Включить», при согласии ниже цели «Сохранить всё равно (согласие N%)» с подтверждением и причиной), `apps/web/src/pages/Direction.tsx` («Проверить Сару на моих решениях»)
- Test: `apps/web/e2e/direction.spec.ts`

- [ ] **Step 1: Failing e2e:** `FR-ACC-4: Boris marks 20 leads one by one and sees "7 из 20" and no score`; `FR-ACC-4: after the last mark he sees the agreement, the misses with "Почему так" and the threshold hint`; `FR-ACC-4: "Предложить поправку" shows the diff and the new agreement and "Применить к черновику" updates the draft`; `FR-ACC-3: step 8 turns the direction on only after 85% or a confirmed override`; `FR-UI-3: the calibration screen fits 360 px in both themes, with thumb-sized buttons` (кнопки не ниже 44 px) `and an empty state` («Заявок пока мало: N из 20»).
- [ ] **Step 2-5:** падение, экран (карточка заявки на весь экран, три кнопки «Взяли бы», «Нет», «Не знаю», клавиши 1-3), зелёные, коммит `feat(web): the calibration screen and enabling the direction`.
- [ ] **Step 6:** проверяющий, PR 5.

---

## PR 6. Формат отклика, кейсы, шаги 5-7, питание Аналитика (FR-ACC-2, FR-LEAD-6)

### Task 17: Место для кейсов и их подстановка (чистые функции)

**Files:**
- Create: `apps/core/src/direction/reply.ts`
- Test: `apps/core/test/direction/reply.test.ts`

**Interfaces:**
- Produces: `analystProfileText(p: {reply_format: ReplyFormat|null; cases: DirectionCase[]}): string` (пусто, если формата и кейсов нет; без ссылок); `caseReserve(p): number` (знаков под кейсы: для `max_cases` самых длинных `\nПохожая работа: {title}, {url}`, 0 при `max_cases` 0 или пустой библиотеке); `placeCases(text: string, p, ids: string[]): {text:string; shown:string[]}` (существующие id без повторов, не больше `max_cases`, только `https://`, дописывает после пустой строки, убирает кейсы с конца, пока `text.length <= 500`, сам текст не режет).

- [ ] **Step 1: Failing tests:** `FR-LEAD-6: without a format or cases the Analyst input stays as it is`; `FR-LEAD-6: the model never sees a case link`; `FR-LEAD-6: unknown and repeated case ids are dropped`; `FR-LEAD-6: not more cases than max_cases`; `FR-LEAD-6: a case that does not fit 500 characters is not added and the text is not cut` (отклик на 499 знаков, Review Focus 6); `FR-LEAD-6: a link that is not https is never placed`; `FR-LEAD-6: the room for cases is taken from the text limit`.
- [ ] **Step 2-5:** падение, реализация, зелёные, коммит `feat(core): placing cases into a bid by the library, not by the model`.

### Task 18: Аналитик читает профиль

**Files:**
- Modify: `packages/shared/src/contracts/roles.ts` (`AnalystOutput.case_ids: z.array(z.string()).max(3).optional()` последним полем), `apps/core/src/leads/draft.ts` (`analystInput(o, maxBody, profile?)`, `writeDraft(gw, o, opts + {profile?})`, `Draft.shownCases`), `roles/analyst/role.md` (раздел «Формат и кейсы направления, если они пришли» и `case_ids`), `roles/analyst/meta.json` (version 2), `apps/core/src/leads/pipeline.ts` (**только** `draftFor`: загрузить `getProfile`, передать; `draftedPayload`: `cases: shown`)
- Test: `apps/core/test/draft.test.ts` (дополнить), `apps/core/test/direction/reply.test.ts`

- [ ] **Step 1: Failing tests:** `FR-LEAD-6: the draft input carries the direction's format and the case rules` (в stdin поддельного CLI раздел «Формат отклика этого направления» и `show_when`, нет `https://`); `FR-LEAD-6: case_ids from the model become links in the draft and the greeting is still first`; `FR-LEAD-6: a draft with a profile without a format and cases is byte for byte the old input` (сравнение с прежним `analystInput`); `FR-LEAD-6: the journal keeps which cases were shown, not the text`.
- [ ] **Step 2-5:** падение, реализация; затем `pnpm test` целиком (тесты Аналитика и карточек соседей зелёные). Коммит `feat(core): the Analyst reads the direction's reply format and cases`.

### Task 19: Профиль в API, шаги 5-7 и противоречия

**Files:**
- Modify: `apps/core/src/direction/routes.ts`, `apps/core/src/direction/onboarding.ts`, `roles/onboarding/role.md`, `packages/shared/src/contracts/onboarding.ts` (`OnbFormat = {understood, reply_format, samples:{lead_id,text}[]}`, `OnbCases = {understood, cases: DirectionCase[]}`)
- Create: `apps/core/src/direction/contradictions.ts`
- Test: `apps/core/test/direction/contradictions.test.ts`, `apps/core/test/direction/onboardingFlow.test.ts`

**Interfaces:**
- Produces: `contradictions(d: {db}, accountId: string, p: {speed, reply_format, cases}): Promise<{id:string; text:string; fix:string}[]>` (правила из дизайна, раздел 6); `PUT /api/directions/:accountId/profile` `{speed?, reply_format?, cases?}` → `{version}` через `saveProfile`; шаг 5 берёт 3 заявки (отмеченные «Взяли бы» в калибровке, иначе последние показанные) и добавляет приветствие программой (`draftOf`); подтверждённые шаги 5-7 попадают в профиль при «Включить» в той же транзакции, что `addVersion` (или без версии, если правила не менялись).

- [ ] **Step 1: Failing tests:** `FR-ACC-2: the profile can be edited outside the onboarding and its version grows`; `FR-ACC-3: step 5 gives three sample bids on real leads, with the greeting from the program`; `FR-ACC-3: Boris's edited samples become the examples of the format`; `FR-ACC-3: step 6 gives cases with show rules`; `FR-ACC-3: step 7 names a budget lower than the bid ceiling`; `FR-ACC-3: step 7 names fast mode with bids off`; `FR-ACC-3: finishing saves the profile and the version in one transaction` (сбой записи профиля откатывает версию).
- [ ] **Step 2-5:** падение, реализация, зелёные, коммит `feat(core): reply format, cases and speed steps with contradiction checks`.

### Task 20: Экраны формата, кейсов, скорости и денег

**Files:**
- Create: `apps/web/src/pages/ReplyProfile.tsx` (редактор формата и кейсов, одинаков для шагов 5-6 и для страницы направления)
- Modify: `apps/web/src/pages/Onboarding.tsx` (шаги 5-7 активны), `apps/web/src/pages/Direction.tsx` (блок «Отклик и кейсы» с «Изменить»)
- Test: `apps/web/e2e/direction.spec.ts`

- [ ] **Step 1: Failing e2e:** `FR-ACC-3: step 5 shows three sample bids that Boris edits`; `FR-ACC-3: step 6 adds a case and asks "Правильно понимаю?"`; `FR-ACC-3: step 7 lists a contradiction with a fix button`; `FR-ACC-2: Boris edits a case on the direction page without an onboarding`; `FR-UI-3: the profile editor fits 360 px in both themes`.
- [ ] **Step 2-5:** падение, экраны, зелёные, коммит `feat(web): the reply format, cases and speed screens`.
- [ ] **Step 6:** проверяющий, PR 6.

---

## PR 7. Маршрутизатор (FR-LEAD-4)

### Task 21: Выбор направления и маршрут заявки

**Files:**
- Modify: `apps/core/src/db/schema.ts` (`leadCandidate`, `leadRoute`)
- Create: `apps/core/src/direction/router.ts`, миграция `0013_router.sql`
- Test: `apps/core/test/direction/router.test.ts`

**Interfaces:**
- Produces: `core.lead_candidate(order_id, account_id, score, decision, stop_factor, margin int, created_at, pk(order_id, account_id))`; `core.lead_route(order_id pk, account_id text|null, state 'none'|'routed', needs_choice bool, alternatives jsonb, decided_at)`; `chooseDirection(c: Candidate[]): {winner: string|null; alternatives: string[]; needsChoice: boolean}` с `Candidate = {accountId:string; state:DirectionState; decision:'show'|'drop'; margin:number}`; `recordCandidate(tx, orderId, c: {accountId, score, decision, stopFactor, margin})` (повтор того же аккаунта заменяет); `decideRoute(db, orderId): Promise<{winner:string|null; needsChoice:boolean}>` (под `pg_advisory_xact_lock(hashtext('route:<order>'))`, идемпотентно, решение один раз, событие `lead.routed`).

- [ ] **Step 1: Failing tests (таблица случаев):** `FR-LEAD-4: nobody fits, nobody gets the order`; `FR-LEAD-4: one fitting direction gets it whatever the others scored`; `FR-LEAD-4: two fit, the bigger margin over its own threshold wins and the other is an alternative needing Boris's choice`; `FR-LEAD-4: equal margins go to the smaller account id`; `FR-LEAD-4: a direction in shadow never wins`; `FR-LEAD-4: a decided route is never reopened by a late candidate`; `FR-LEAD-4: two decideRoute calls at once give one route`.
- [ ] **Step 2-5:** падение, реализация, зелёные, коммит `feat(core): the router chooses one direction for an order`.

### Task 22: Охрана от двойного отклика и подключение к конвейеру

**Files:**
- Modify: `apps/core/src/db/schema.ts` (частичный уникальный индекс `outbox_one_bid_per_order` по `(payload->>'leadId')` где `kind = 'bid'`; миграция `0014_one_bid_per_order.sql`), `apps/core/src/leads/outbox.ts` (`recordBid` отказывает, если у заказа есть маршрут и аккаунт не победитель), `apps/core/src/leads/pipeline.ts` (**только** после шага `scored`: `recordCandidate` и `decideRoute` за `DBOS.patch('router')`; проигравший маршрута карточку не получает; единственный аккаунт получает её как сегодня)
- Test: `apps/core/test/direction/routerGuard.test.ts`

- [ ] **Step 1: Failing tests:** `FR-LEAD-4: two bids on one order are impossible` (два аккаунта, один заказ, параллельный `recordBid` с разными `accountId` и ключами: одна запись, второй `created:false`, один `bid.requested`); `FR-LEAD-4: the database refuses a second bid row for an order even with another key` (прямая вставка с другим `idempotency_key` падает по индексу); `FR-LEAD-4: a bid from an account that lost the route is refused`; `FR-LEAD-4: with one account the pipeline gives the same card as before` (существующие тесты конвейера зелёные без изменений); `FR-LEAD-4: an order recorded before the router resumes without it` (процесс без шага `router` продолжается, не падает на повторе).
- [ ] **Step 2-5:** падение, реализация, полный `pnpm test`, коммит `feat(core): ST-M3 one bid per order in the database and in recordBid; routing in the pipeline`.

### Task 23: Заключение

**Files:**
- Modify: `docs/architecture/contracts.md`, `docs/architecture/data-dictionary.md`, `docs/quality/traceability.md`, `docs/product/backlog.md` (истории M3), новый `docs/handoff/2026-10-25-m3.md`, `docs/ops/runbooks.md` (калибровка зависла, прогон остановлен лимитом, «правила изменились, пока ты настраивал»)

- [ ] **Step 1:** обновить документы; `pnpm check`. **Step 2:** проверяющий, PR 7. **Step 3:** сводка для Бориса по-русски (раздел 9 дизайна вопросами). **Step 4:** убрать контейнер `docker rm -f sara-pg-m3`.

---

## Self-review

- Покрытие дизайна: раздел 2 (задачи 2-3), 3 (6-8, 15, 19-20), 4 (13-16), 5 (9-12), 6 (17-20), 7 (21-22), 8 (5, 8, 12, 16, 20), 10 (все PR). Журнал событий: задачи 2, 7, 10, 21.
- Типы: `rulesHash`, `trialScore`, `createRun`, `CalibrationResult`, `chooseDirection` названы одинаково в задачах и дизайне.
- Пропорция: задачи называют сигнатуры, тесты и значения, тела функций не расписаны.
