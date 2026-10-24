# Правила направления и обучаемая оценка: план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Заявка после Сортировщика получает балл по правилам старой Сары (версия 1). Борису приходят только подходящие. Его решения, причины текстом или голосом, дневная сводка отсеянного и предложения поправок с «да» Бориса уточняют правила версиями.

**Architecture:** Правила направления хранятся данными с версиями в `core.direction_version`. Роль Оценщик (`roles/scorer`, haiku, sonnet при спорном) ставит баллы по осям, итог и решение считает код. Обучение (метки, вопросы «почему?», сводка, предложения) живёт в `apps/core/src/learning/`. Задачи в нём идут минутным тиком `startLearningJobs`. Бот принимает текст и голос, голос распознаёт whisper.cpp в контейнере ядра.

**Tech Stack:** TypeScript, Fastify, Drizzle (Postgres, схема `core`), DBOS (уже есть), grammY, `claude -p` через шлюз, zod, vitest, whisper.cpp (`whisper-cli`), ffmpeg.

**Spec:** `docs/superpowers/specs/2026-10-24-direction-scoring-design.md`

## Global Constraints

- Все тексты Борису по-русски, простым языком, без длинного тире «—» (`pnpm check` гоняет `scripts/check-dash.ts`).
- Имя клиента никогда не уходит в модель (ADR-016): во вход Оценщика и Предлагающего оно не попадает.
- Порог версии 1: 56. Веса версии 1: качество клиента 30, системность задачи 25, бюджетная зрелость 20, конкурентность заявки 15, чек и LTV 10. Веса в сумме 100.
- Спорная оценка: балл в пределах 10 от порога (`|score - threshold| <= 10`) или `confidence < 0.6`, тогда повтор на sonnet, и решает его результат.
- Удивление: «Пропустить» на карточке с баллом `>= threshold + 15`, или «Взял бы» в сводке. Не больше 3 вопросов «почему?» в сутки по Москве.
- Причина: ответ (reply) на сообщение-вопрос или следующее сообщение в течение 30 минут после последнего открытого вопроса.
- Слабое «нет»: карточка без нажатия 24 часа.
- Сводка: 19:00 по Москве (`Europe/Moscow`), до 3 заявок с баллом в `[threshold - 10, threshold)` без стоп-фактора, по убыванию балла.
- Предложение: не меньше 3 удивлений с причиной после прошлого предложения, не чаще раза в сутки, пока нет предложения в состоянии `asked`.
- Проверка на прошлом: последние 50 заявок с меткой и оценкой, переоценка haiku без повтора на sonnet.
- Имена тестов начинаются с ID требования (`pnpm trace`): FR-ACC-2 правила и версии, FR-LEAD-3 оценка, FR-LEAD-7 карточка и пропуск с причиной, FR-MIND-3 изменения только после «да» и откат, NFR-REL-3 перезапуск, NFR-UX-1 тексты.
- Каждое новое событие журнала вносится в `EVENT_TYPES` (`packages/shared/src/contracts/eventTypes.ts`).

## Review Focus

1. Борис отвечает через 40 минут не reply-ем: причина не привязывается, Сара отвечает «Пока я понимаю только ответы на мои вопросы». Тест в Task 6.
2. Двойное нажатие «Взял бы» или «Применить»: второе даёт «Уже сделано», вторая карточка или вторая версия не появляются. Тесты в Task 7 и Task 8.
3. Голос не распознался (ffmpeg или whisper упали, пустой текст): «Не смогла разобрать голосовое, напиши текстом, пожалуйста», причина не пишется. Тест в Task 6.
4. Предлагающий вернул правила, которые не проходят схему (веса не 100, пустые оси): предложение отбрасывается без сообщения Борису, в журнале `rules.proposal_invalid`. Тест в Task 8.
5. Ядро перезапустилось в 19:00 или тик сработал дважды: сводка за день ровно одна (уникальная запись `core.job_run`). Тест в Task 7.

---

### Task 1: Правила направления как данные с версиями

**Files:**
- Create: `packages/shared/src/contracts/direction.ts` (экспорт из `packages/shared/src/index.ts`)
- Create: `apps/core/src/direction/v1.ts`, `apps/core/src/direction/store.ts`, `apps/core/src/direction/cli.ts`
- Modify: `apps/core/src/db/schema.ts`, новая миграция `apps/core/drizzle/0003_direction.sql` (через `drizzle-kit generate`), `apps/core/src/app.ts` (seed при старте), `apps/core/package.json` и корневой `package.json` (скрипты `direction:show`, `direction:rollback`), `packages/shared/src/contracts/eventTypes.ts` (`direction.version_created`)
- Test: `apps/core/test/direction.test.ts`

**Interfaces:**
- Produces: `DirectionRules` (zod): `{ about: string; stop_factors: {id: string; text: string; exception: string | null; examples: string[]}[]; red_flags: {id: string; text: string; soft: boolean}[]; axes: {id: AxisId; title: string; weight: number; how: string}[]; threshold: number; notes: string[] }`, `refine`: веса целые, сумма 100, `id` осей уникальны, `threshold` 0-100.
- Produces: `weightedScore(rules: DirectionRules, axes: Record<string, number>): number` (округление до целого, оси без балла дают ошибку).
- Produces: `RULES_V1: DirectionRules` в `v1.ts`.
- Produces в `store.ts`: `seedDirection(db, accountId): Promise<void>` (создаёт v1, если версий нет), `activeRules(db, accountId): Promise<{ version: number; rules: DirectionRules }>`, `addVersion(db, { accountId, rules, createdBy: 'seed' | 'boris', reason }): Promise<number>` (новая становится активной, прежняя нет, одной транзакцией, событие `direction.version_created`), `rollbackTo(db, accountId, version): Promise<number>` (новая версия с правилами `version` и причиной `откат к v${version}`).
- Таблица `core.direction_version`: `account_id text`, `version int`, `rules jsonb`, `created_at`, `created_by text`, `reason text`, `active boolean`; первичный ключ `(account_id, version)`; частичный уникальный индекс по `account_id` где `active`.

- [ ] **Step 1: Write the failing tests** в `apps/core/test/direction.test.ts`:
  - `FR-ACC-2: v1 holds old Sara's five axes, weights 30/25/20/15/10 and threshold 56`: `RULES_V1.axes.map(a => [a.id, a.weight])` равно `[['client',30],['system',25],['budget',20],['competition',15],['ltv',10]]`, `threshold` 56, в `stop_factors` есть `direct`, `narrow_tool` (с непустым `exception`), `vacancy`, `percent`, `one_off_tech`.
  - `FR-ACC-2: rules whose weights do not add up to 100 are refused`: `DirectionRules.safeParse({...RULES_V1, axes: [...с весом 31]}).success === false`.
  - `FR-LEAD-3: the score is the weighted sum of the axes`: `weightedScore(RULES_V1, {client: 80, system: 60, budget: 50, competition: 40, ltv: 30}) === 59` (24+15+10+6+3).
  - `FR-ACC-2: the seed writes v1 once and it is the active version`: два вызова `seedDirection`, затем `activeRules` даёт `version 1`, в таблице одна строка.
  - `FR-MIND-3: a rollback is a new version with the old rules, history kept`: v1, `addVersion` (threshold 60) даёт v2, `rollbackTo(…, 1)` даёт 3, активна v3 с threshold 56, все три строки на месте, ровно одна `active`.
- [ ] **Step 2: Run** `pnpm vitest run --project core test/direction.test.ts`, ожидаем FAIL (нет модулей).
- [ ] **Step 3: Implement.** Тексты `RULES_V1` переносят смысл `src/analyzer/prompt.js` и пунктов «Пропускай» из `src/analyzer/batchTriagePrompt.js` старой папки (`~/(SaraAI)Профи.Ру — бот /src/analyzer/`), без длинного тире. `about` описывает Hance как в старом промпте. `notes` содержит уточнение про бюджетную зрелость от 13.09 и про то, что клиенты редко пишут «долгосрочное сотрудничество». Seed вызывается в `startApp` после `seedAccounts` для каждого аккаунта. CLI (`tsx apps/core/src/direction/cli.ts show|rollback <v>`) печатает активную версию, список версий (номер, дата МСК, кто, причина) и результат отката.
- [ ] **Step 4: Run** тест и `pnpm check`, ожидаем PASS.
- [ ] **Step 5: Commit** `feat(core): direction rules as versioned data, v1 from old Sara`.

### Task 2: Оценщик

**Files:**
- Create: `roles/scorer/meta.json` (`haiku`, fallback `sonnet`, priority `P2`, timeout 90000), `roles/scorer/role.md`, `apps/core/src/leads/scorer.ts`
- Modify: `packages/shared/src/contracts/roles.ts` (`ScorerOutput`), `apps/core/src/gateway/roles.ts` (`RoleName` + `'scorer' | 'rules-proposer'`), `apps/core/src/gateway/gateway.ts` (`opts.model`), `tests/fakes/fake-claude.mjs` (вывод по роли)
- Test: `apps/core/test/scorer.test.ts`, `apps/core/test/gateway.test.ts`

**Interfaces:**
- Consumes: `DirectionRules`, `weightedScore` (Task 1).
- Produces: `ScorerOutput` (zod): `{ stop_factor: string | null; red_flags: string[]; axes: {id: string; score: number (0-100, int); why: string (≤160)}[]; reason: string (≤300); confidence: number (0-1) }`.
- Produces: `Gateway.call(role, input, schema, opts?: { correlationId?; causationId?; model?: string })`. `model` заменяет `meta.model`, а `fallbackModel` при этом не передаётся.
- Produces в `scorer.ts`: `rulesText(rules: DirectionRules): string` (правила по разделам, текстом для модели); `scorerInput(o: ProfiOrder, rules: DirectionRules): string` (`rulesText` плюс заказ как в `sorterInput`, без имени клиента); `type Scored = { score: number; decision: 'show' | 'drop'; stopFactor: string | null; redFlags: string[]; axes: ScorerOutput['axes']; reason: string; confidence: number; model: 'haiku' | 'sonnet' }`; `decide(rules, out: ScorerOutput): Pick<Scored, 'score' | 'decision'>`; `scoreOrder(gw, o, rules, opts?: { escalate?: boolean (по умолчанию true); correlationId?; causationId? }): Promise<Scored | null>` (null, если оба вызова не удались, или если `stop_factor` не из правил, или оси не совпали с правилами).
- Fake Claude: если задан `FAKE_CLAUDE_OUTPUT_BY_ROLE` (JSON `{ "<роль>": <вывод> }`), роль берётся из пути `--system-prompt-file` (`…/roles/<роль>/role.md`); если в карте есть `"<роль>@<модель>"`, он важнее (модель из `--model`).

- [ ] **Step 1: Write the failing tests:**
  - `FR-LEAD-3: the Scorer never sees the client's name` (ADR-016): `scorerInput({...order, client_name: 'Андрей'}, RULES_V1)` не содержит `Андрей`, содержит текст заказа и `Порог: 56`.
  - `FR-LEAD-3: a stop factor drops the order whatever the score`: `decide(RULES_V1, {stop_factor: 'direct', axes: все по 90, …}).decision === 'drop'`.
  - `FR-LEAD-3: below the threshold is dropped, at the threshold is shown`: оси дают 55, тогда `drop`; оси дают 56, тогда `show`.
  - `FR-LEAD-3: a borderline haiku score is redone on sonnet and sonnet decides`: `scorer@haiku` даёт 60, `scorer@sonnet` даёт 40; `scoreOrder` возвращает `score 40`, `decision 'drop'`, `model 'sonnet'`; в логе fake (`FAKE_CLAUDE_ARGS_LOG`) два вызова, второй с `--model sonnet`.
  - `FR-LEAD-3: a clear haiku score is not redone`: haiku даёт 85 при `confidence 0.9`, тогда один вызов.
  - `FR-LEAD-3: an unknown stop factor id counts as a failed score`: `stop_factor: 'nonsense'`, тогда `null`.
  - В `gateway.test.ts`: `FR-LEAD-3: a call can name its model`: `call('probe', …, {model: 'sonnet'})` передаёт `--model sonnet` и не передаёт `--fallback-model`.
- [ ] **Step 2: Run** `pnpm vitest run --project core test/scorer.test.ts test/gateway.test.ts`, ожидаем FAIL.
- [ ] **Step 3: Implement.** `role.md`: ты Оценщик Hance, правила направления приходят во входе, оцени каждую ось из правил 0-100 с причиной, назови сработавший стоп-фактор по `id` или `null`, найди красные флаги по `id`, `reason` 1-2 фразы по-русски без длинного тире, итоговый балл не считай. `scorerInput` печатает правила по разделам (стоп-факторы с исключениями и примерами, красные флаги, оси с весами и «как оценивать», уточнения, `Порог: N`), затем заказ.
- [ ] **Step 4: Run** тесты и `pnpm check`, PASS.
- [ ] **Step 5: Commit** `feat(core): the Scorer role, axes by the model, score and decision by code`.

### Task 3: Оценка в конвейере и карточке

**Files:**
- Modify: `apps/core/src/db/schema.ts` + миграция `0004_lead_score.sql`, `apps/core/src/leads/pipeline.ts`, `apps/core/src/notify/cards.ts`, `packages/shared/src/contracts/eventTypes.ts` (`lead.scored`)
- Create: `tests/e2e/scoring.test.ts`
- Test: `apps/core/test/cards.test.ts`

**Interfaces:**
- Consumes: `activeRules` (Task 1), `scoreOrder` (Task 2).
- Таблица `core.lead_score`: `id uuid`, `lead_id text`, `version int`, `score int`, `decision text` (`show`/`drop`), `stop_factor text null`, `red_flags jsonb`, `axes jsonb`, `reason text`, `confidence real`, `model text`, `backtest boolean default false`, `created_at`. Индекс `(lead_id, backtest)`.
- `LeadCard` получает `score: { value: number; version: number; reason: string } | null` и `unscored?: boolean`.
- Статус лида `scored_out` для `drop`.

- [ ] **Step 1: Write the failing tests:**
  - `cards.test.ts`, `FR-LEAD-7: the card shows the score, the rules version and the reason`: текст карточки содержит `Балл 68 (правила v1). Зрелый бизнес`, затем строку `Отклик 148 ₽`; строки «Подходит:» при наличии балла нет.
  - `FR-LEAD-7: a card without a score says so`: при `unscored: true` есть строка `Без оценки: Оценщик не ответил`.
  - `tests/e2e/scoring.test.ts` (по образцу `tests/e2e/skeleton.test.ts`, `claudeEnv` с `FAKE_CLAUDE_OUTPUT_BY_ROLE`):
    - `FR-LEAD-3: an order above the threshold becomes a card with its score`: Сортировщик `fit`, Оценщик даёт 70, тогда карточка пришла, `lead_score` одна строка `decision 'show'`, событие `lead.scored`.
    - `FR-LEAD-3: an order below the threshold stays silent as scored_out`: Оценщик даёт 40, тогда карточек нет, статус `scored_out`.
    - `FR-LEAD-3: a failed Scorer still brings the card, marked without a score`: Оценщик в режиме ошибки (вывод не по схеме), тогда карточка с `Без оценки`.
- [ ] **Step 2: Run** `pnpm vitest run --project core test/cards.test.ts` и `pnpm vitest run --project e2e tests/e2e/scoring.test.ts`, FAIL.
- [ ] **Step 3: Implement.** В `processOrder` после шага `sort` (если не `reject`) идёт шаг DBOS `score` (`activeRules` и `scoreOrder`), затем шаг записи `lead_score` и `lead.scored`. `drop` ставит `scored_out` и завершает. `show` или `null` ведёт к задаче и карточке, как сейчас. `cardOfTask` (напоминание) берёт последнюю оценку не из проверки (`backtest = false`).
- [ ] **Step 4: Run** тесты, весь `pnpm test`, `pnpm check`, PASS.
- [ ] **Step 5: Commit** `feat(core): orders are scored before a card, the card shows the score`.

### Task 4: Метки решений Бориса

**Files:**
- Create: `apps/core/src/learning/labels.ts`, `apps/core/src/learning/jobs.ts`
- Modify: `apps/core/src/db/schema.ts` + `0005_learning.sql` (таблицы этой и следующих задач: `lead_label`, `question`, `job_run`, `rule_proposal`), `apps/core/src/leads/pipeline.ts` (`onPress`), `apps/core/src/app.ts` (`startLearningJobs`), `eventTypes.ts` (`lead.labeled`)
- Test: `apps/core/test/learning/labels.test.ts`

**Interfaces:**
- Таблицы:
  - `core.lead_label`: `lead_id text pk`, `label text` (`yes`/`no`/`weak_no`), `source text` (`card`/`summary`/`ignored`), `reason text null`, `voice boolean default false`, `score int null`, `score_version int null`, `surprise boolean default false`, `at`.
  - `core.question`: `id uuid`, `kind text` (`why_skip`/`why_want`/`why_decline`), `entity_id text` (лид или предложение), `telegram_message_id bigint null`, `asked_at`, `answered_at null`, `answer text null`.
  - `core.job_run`: `name text`, `day date` (по Москве), pk `(name, day)`.
  - `core.rule_proposal`: `id uuid`, `account_id`, `from_version int`, `rules jsonb`, `summary text`, `why text`, `backtest jsonb`, `state text` (`asked`/`applied`/`declined`), `task_id uuid null`, `created_at`, `decided_at null`.
- Produces: `recordLabel(db, { leadId, label, source }): Promise<{ created: boolean; surprise: boolean }>`. Метка ставится один раз (`on conflict do nothing`). Балл и версия берутся из последней `lead_score` не из проверки. `surprise` для `no` из `card` при `score >= threshold + 15` по правилам той версии, для `yes` из `summary` всегда.
- Produces: `sweepIgnored(db, now: Date): Promise<number>`: открытые задачи `lead_decision` старше 24 часов без метки получают `weak_no` из `ignored`.
- Produces: `startLearningJobs(d: { db; notifier; gateway; now?: () => Date; tickMs?: number }): { stop(): void; tick(): Promise<void> }`. Тик раз в минуту вызывает по очереди `sweepIgnored` и задачи из Task 7 и Task 8. Ошибка одного шага не мешает остальным.

- [ ] **Step 1: Write the failing tests:**
  - `FR-LEAD-7: «Откликнуться» is a yes, «Пропустить» is a no, each once`: два `recordLabel` на один лид, тогда одна строка, второй `created: false`.
  - `FR-LEAD-7: skipping a card of 71 under threshold 56 is a surprise, of 70 is not`.
  - `FR-LEAD-7: a card untouched for 24 hours is a weak no without a question`: задача создана 25 часов назад, `sweepIgnored` даёт 1 строку `weak_no`, `ignored`; задача 23 часа назад меток не даёт.
  - `FR-LEAD-7: a press on the card writes its label` (через `pipeline.onPress` в e2e `scoring.test.ts`): «Пропустить» записывает `no` из `card`.
- [ ] **Step 2: Run**, FAIL. **Step 3: Implement**, `onPress` вызывает `recordLabel` после успешного разрешения задачи (`bid` даёт `yes`, `skip` даёт `no`). **Step 4: Run**, PASS. **Step 5: Commit** `feat(core): Boris's decisions become labels for learning`.

### Task 5: Вопрос «почему?» при удивлении

**Files:**
- Create: `apps/core/src/learning/questions.ts`
- Modify: `apps/core/src/notify/cards.ts` (`TEXTS`), `apps/core/src/notify/notifier.ts`, `apps/core/src/notify/telegram.ts` и `apps/core/src/notify/botControl.ts` (`sendText(text): Promise<{ messageId: number }>`; новый `sendButtons(text, rows: { text: string; callbackData: string }[][]): Promise<{ messageId: number }>` для сводки и предложений), `apps/core/src/leads/pipeline.ts`, `eventTypes.ts` (`question.asked`, `question.answered`)
- Test: `apps/core/test/learning/questions.test.ts`

**Interfaces:**
- Consumes: `recordLabel` (Task 4).
- Produces: `askWhy(d: { db; notifier }, { kind, entityId, title }, now: Date): Promise<boolean>` (false при лимите 3 в сутки по Москве). Вопрос пишется в `core.question` с `telegram_message_id`.
- Produces: `answerQuestion(db, { text, replyToMessageId: number | null, voice: boolean, at: Date }): Promise<{ question: QuestionRow } | null>`. Порядок: по `replyToMessageId`; иначе последний неотвеченный вопрос не старше 30 минут. Ответ пишется в `question.answer` и в `lead_label.reason` (`voice`) для `why_skip`/`why_want`, в `rule_proposal` не пишется (Task 8 читает `question`).
- Тексты (`TEXTS`): `whySkip: (title) => \`Почему пропустил «${title}»? Напиши или скажи голосом.\``, `whyWant: (title) => \`Почему взял бы «${title}»? Напиши или скажи голосом.\``, `whyDecline: 'Почему не надо эту поправку? Напиши или скажи голосом.'`, `noted: (t) => \`Записала: «${t}»\``, `notAnAnswer: 'Пока я понимаю только ответы на мои вопросы'`, `voiceFailed: 'Не смогла разобрать голосовое, напиши текстом, пожалуйста'`.

- [ ] **Step 1: Write the failing tests:**
  - `FR-LEAD-7: a surprising skip brings one question with the order title`: удивительный `no`, тогда `tg.sent` содержит `Почему пропустил «Реклама на ТВ»?`.
  - `FR-LEAD-7: no more than 3 questions a day, the 4th surprise is kept without asking`: 4 удивления, тогда 3 вопроса, у 4-го метка `surprise: true`, вопроса нет.
  - `FR-LEAD-7: a reply to the question is its reason`: `answerQuestion({ replyToMessageId: <id вопроса> })` пишет `lead_label.reason`.
  - `FR-LEAD-7: a plain message within 30 minutes answers the latest question; after 30 minutes it answers nothing`: 29 минут даёт ответ, 31 минута даёт `null`.
- [ ] **Step 2-4:** Run FAIL, implement (после `recordLabel` в `onPress`: если `surprise`, то `askWhy`), Run PASS.
- [ ] **Step 5: Commit** `feat(core): Sara asks why when Boris's decision surprises her`.

### Task 6: Текст и голос от Бориса в боте

**Files:**
- Create: `apps/core/src/notify/transcribe.ts`, `tests/fakes/fake-whisper.mjs`
- Modify: `apps/core/src/notify/telegram.ts`, `apps/core/src/notify/botControl.ts` (`onMessage`), `apps/core/src/app.ts`, `apps/core/src/config.ts` (`whisperBin`, `whisperModel`, `ffmpegBin`), `tests/fakes/telegramApi.ts` (`pushText`, `pushVoice`, `getFile`, файл по `/file/bot<token>/<path>`), `infra/docker/core.Dockerfile` (ffmpeg, whisper.cpp), `infra/compose.prod.yml` при необходимости (переменные), `docs/ops/server-setup.md` (модель в `/data/whisper/ggml-small.bin`)
- Test: `apps/core/test/bot.test.ts`, `apps/core/test/transcribe.test.ts`

**Interfaces:**
- Consumes: `answerQuestion`, `TEXTS` (Task 5).
- Produces: `createTranscriber(c: { ffmpegBin; whisperBin; modelPath; timeoutMs?: number (по умолчанию 120000) }): { transcribe(oggPath: string): Promise<string | null> }`. ffmpeg переводит в 16 кГц mono wav, затем `whisper-cli -m <model> -l ru -nt -f <wav>`. Пустой текст, ненулевой код или таймаут дают `null`. Временные файлы удаляются.
- Bot: `onMessage(m: { text: string; replyToMessageId: number | null; voice: boolean }): Promise<string>` возвращает текст ответа Борису. Голос: `getFile`, скачать в `dataDir/voice/`, `transcribe`, `null` даёт `TEXTS.voiceFailed`. Сообщения из чужого чата отсекает уже существующий `bot.use` (тест на это есть, проверить, что текст и голос из чужого чата пишут `security.foreign_chat` и `onMessage` не зовётся).
- Ответ: `answerQuestion` нашёл вопрос, тогда `TEXTS.noted(text)`; иначе `TEXTS.notAnAnswer`.
- Dockerfile: whisper.cpp собирается из закреплённого тега (`v1.7.x`, последний на дату сборки, записать в ARG) стадией сборки, в образ копируется только `whisper-cli`. Модель качается скриптом `infra/whisper/fetch-model.sh` в том `/data` один раз и проверяется по sha256 из `huggingface.co/ggerganov/whisper.cpp`.

- [ ] **Step 1: Write the failing tests:**
  - `transcribe.test.ts`, `FR-LEAD-7: a voice message becomes text`: `fake-whisper.mjs` печатает `" бюджет копейки "`, тогда `transcribe` даёт `бюджет копейки`.
  - `FR-LEAD-7: a failed recognition gives null`: fake с кодом 1, тогда `null`; fake с пустым выводом, тогда `null`.
  - `bot.test.ts`, `FR-LEAD-7: Boris's reply text to a question is noted`: вопрос отправлен, `tg.pushText(chat, 'бюджет копейки', replyTo)`, тогда в `tg.sent` есть `Записала: «бюджет копейки»`.
  - `FR-LEAD-7: a voice answer is recognized and noted, marked as voice`: `tg.pushVoice`, fake whisper, тогда `Записала: «…»`, `lead_label.voice = true`.
  - `FR-LEAD-7: an unrecognized voice asks for text and notes nothing`.
  - `FR-LEAD-7: a message that answers nothing gets «Пока я понимаю только ответы на мои вопросы»`.
  - `NFR-SEC-1: text and voice from a foreign chat are ignored and logged`.
- [ ] **Step 2-4:** Run FAIL, implement, Run PASS. Проверить сборку образа локально: `docker build -f infra/docker/core.Dockerfile .` и `docker run --rm <образ> whisper-cli --help`.
- [ ] **Step 5: Commit** `feat(core): Boris answers by text or voice, recognized on the server`.

### Task 7: Дневная сводка отсеянного и «Взял бы»

**Files:**
- Create: `apps/core/src/learning/summary.ts`
- Modify: `packages/shared/src/contracts/telegram.ts` (`TASK_ACTIONS` + `'want' | 'apply' | 'drop'`), `apps/core/src/notify/cards.ts` (`TEXTS.summary…`, клавиатура сводки), `apps/core/src/leads/pipeline.ts` (`onPress` для `want`, общий `sendCardForLead(leadId)`), `apps/core/src/learning/jobs.ts`
- Test: `apps/core/test/learning/summary.test.ts`

**Interfaces:**
- Consumes: `recordLabel`, `askWhy`, `job_run`.
- Produces: `dailySummary(d: { db; notifier }, now: Date): Promise<'sent' | 'none' | 'already'>`. Срабатывает, если по Москве `>= 19:00` и записи `job_run ('summary', день)` ещё нет. Запись вставляется первой (`on conflict do nothing`), и тот, кто вставил, отправляет. Считаются лиды `scored_out` с `seen_at` в этот день по Москве. Пограничные: последняя оценка `score` в `[threshold - 10, threshold)`, без `stop_factor`, без метки, до 3 по убыванию балла. На каждую создаётся задача `lead_review` (сущность лид) с кнопкой `Взял бы` (`want`).
- Тексты: `summaryHead: (n) => \`Сегодня отсеяла ${n}. На грани:\``, строка заявки `\`${title}, балл ${score}: ${reason}\``, `summaryNone: (n) => \`Сегодня отсеяла ${n}, пограничных не было\``, кнопка `Взял бы`. Если отсеянных 0, ничего не отправляется (`'none'`).
- `want`: разрешает задачу `lead_review` один раз, `recordLabel(yes, summary)`, `askWhy(why_want)`, затем новая задача `lead_decision` и обычная карточка по лиду. Повтор даёт `TEXTS.alreadyDone`.

- [ ] **Step 1: Write the failing tests:**
  - `FR-LEAD-7: at 19:00 Moscow time the day's dropped orders come as one summary with up to 3 borderline ones`: 5 отсеянных (баллы 55, 50, 47, 44, 20 и одна со стоп-фактором при 54), тогда одно сообщение `Сегодня отсеяла 6. На грани:` и три кнопки по 55, 50, 47.
  - `FR-LEAD-7: before 19:00 there is no summary; a second tick the same day sends nothing` (`'already'`).
  - `NFR-REL-3: two cores ticking at once send one summary` (два параллельных `dailySummary`, один `'sent'`).
  - `FR-LEAD-7: «Взял бы» is a yes, asks why and brings a normal card; pressing again does nothing`.
  - `FR-LEAD-7: a day without dropped orders sends nothing`.
- [ ] **Step 2-4:** Run FAIL, implement, Run PASS.
- [ ] **Step 5: Commit** `feat(core): the daily summary of dropped orders with «Взял бы»`.

### Task 8: Предложение поправки, проверка на прошлом, «Применить»

**Files:**
- Create: `roles/rules-proposer/meta.json` (`sonnet`, fallback `opus`, `P3`, timeout 180000), `roles/rules-proposer/role.md`, `apps/core/src/learning/proposals.ts`, `apps/core/src/learning/backtest.ts`
- Modify: `packages/shared/src/contracts/roles.ts` (`RulesProposalOutput`), `apps/core/src/notify/cards.ts`, `apps/core/src/leads/pipeline.ts` (`onPress` для `apply`/`drop`), `apps/core/src/learning/jobs.ts`, `eventTypes.ts` (`rules.proposed`, `rules.applied`, `rules.declined`, `rules.proposal_invalid`)
- Test: `apps/core/test/learning/proposals.test.ts`

**Interfaces:**
- Consumes: `activeRules`, `addVersion`, `DirectionRules` (Task 1), `scoreOrder` с `escalate: false` (Task 2), `question` с ответами (Task 5), `askWhy` (Task 5).
- Produces: `RulesProposalOutput` (zod): `{ summary: string (≤300); why: string (≤300); rules: unknown }`. `rules` проверяется `DirectionRules` в коде.
- Produces: `backtest(d: { db; gateway }, accountId, rules: DirectionRules): Promise<{ checked: number; changed: number; towardBoris: number; against: number }>`. Берёт последние 50 лидов с меткой и оценкой. Для каждого `scoreOrder(…, { escalate: false })` по новым правилам, запись в `lead_score` с `backtest = true`. `changed`: решение отличается от решения последней боевой оценки. `towardBoris`: новое решение совпадает с меткой (`yes` значит `show`, `no`/`weak_no` значит `drop`).
- Produces: `maybePropose(d: { db; gateway; notifier }, accountId, now: Date): Promise<'asked' | 'not_yet' | 'invalid'>`. Условия из Global Constraints. Вход роли: `rulesText` активных правил (Task 2) и до 20 последних отвеченных удивлений (заказ без имени клиента, балл Сары, решение Бориса, его причина). Неверные правила дают `rules.proposal_invalid` и `'invalid'`, Борису ничего не уходит.
- Сообщение (кнопки `Применить` = `apply`, `Не надо` = `drop` на задаче `rule_proposal`):
  ```
  Предлагаю поправку правил (v{from} → v{from+1}): {summary}
  Почему: {why}
  На последних {checked} заявках это изменило бы {changed} решений: {towardBoris} в твою сторону, {against} против.
  ```
- `apply`: `addVersion(createdBy: 'boris', reason: summary)`, `state applied`, ответ `Применила, теперь правила v{N}`. `drop`: `state declined`, `askWhy(why_decline)`, ответ `Хорошо, оставляю v{from}`. Если `from_version` уже не активна (откат или другая поправка), `apply` отвечает `Правила уже поменялись, предложение устарело` и ничего не меняет.

- [ ] **Step 1: Write the failing tests:**
  - `FR-MIND-3: three answered surprises bring one proposal with its backtest numbers`: 3 отвеченных удивления, fake `rules-proposer` даёт правила с threshold 60, fake `scorer` на 4 лидах с метками, тогда одно сообщение с `v1 → v2` и строкой `На последних 4 заявках это изменило бы`.
  - `FR-MIND-3: nothing changes until «Применить»`: после сообщения `activeRules` даёт v1; после `apply` даёт v2 с `created_by 'boris'`; второе `apply` даёт `Уже сделано`.
  - `FR-MIND-3: «Не надо» keeps the rules and asks why`.
  - `FR-MIND-3: no new proposal while one waits, and not twice a day`.
  - `FR-MIND-3: rules that break the schema are thrown away without a message` (`rules.proposal_invalid`).
  - `FR-MIND-3: a proposal made for v1 is not applied after a rollback to another version`.
- [ ] **Step 2-4:** Run FAIL, implement, Run PASS.
- [ ] **Step 5: Commit** `feat(core): rule proposals with a backtest, applied only on Boris's yes`.

### Task 9: Проверка Оценщика на заявках старой Сары

**Files:**
- Create: `apps/core/src/leads/scoreEvalCli.ts`, `docs/quality/scorer-check-2026-10-24.md`
- Modify: `apps/core/package.json` (`score:eval`)

**Interfaces:**
- Consumes: `RULES_V1`, `scoreOrder` (с повтором на sonnet, как в бою), `createGateway`.
- CLI: `tsx apps/core/src/leads/scoreEvalCli.ts <leads.json> <out.jsonl>`, файл формата выгрузки 24.10 (`{ leads: [{ id, category, description, budget, city, decision, score, sets, … }] }`). Продолжает с места остановки, по 3 вызова одновременно. Печатает итог: совпадение «показать/отсеять» с `respond/skip` старой Сары (с её порогом 56), сколько из `responded` отсеяно, доля «показать» среди прошедших Сортировщик.

- [ ] **Step 1:** Выкатить ветку с Task 1-8 на сервер (без `leads:on`), положить выборку `old.json` в контейнер ядра (как 24.10), запустить CLI в фоне (`nohup`), дождаться итога.
- [ ] **Step 2:** Совпадение не ниже 85% и из 23 `responded` отсеяно не больше 2: записать цифры и 5 характерных расхождений (темы заказов без данных клиентов) в `docs/quality/scorer-check-2026-10-24.md`. Иначе остановиться и показать Борису расхождения с причинами Оценщика (спека 5.1).
- [ ] **Step 3: Commit** `docs(quality): the Scorer checked on old Sara's leads`.

### Task 10: Независимая проверка, выкладка, включение

- [ ] **Step 1:** Свежий проверяющий на самой сильной модели читает всю ветку против спеки и этого плана. Найденное исправляется с тестом.
- [ ] **Step 2:** PR, CI зелёный, слияние, `bash scripts/deploy.sh sara@143.246.42.121`, на сервере `infra/whisper/fetch-model.sh`, проверить `docker compose exec core whisper-cli --help` и `pnpm direction:show` (активна v1).
- [ ] **Step 3:** Сообщить Борису цифры Task 9 и ожидаемое число карточек в день. После этого `pnpm leads:on` на сервере (Борис уже попросил включить после правил), проверить первую оценённую заявку в `core.lead_score`.
