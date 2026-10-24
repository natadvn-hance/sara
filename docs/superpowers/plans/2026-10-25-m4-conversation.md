# M4 «Разум и разговор»: план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Сара в тени пишет черновик ответа на каждую реплику клиента голосом Бориса по циклу из 8 шагов с номерами записей разума, проверкой и правилами; черновики приходят Борису и сравниваются с тем, что реально ушло; история чатов выгружена с разделением авторов; экзамен из 60 сценариев сторожит выкладку.

**Architecture:** Новые модули ядра: `conversation/` (синхронизация чата, разговор, ход как процесс DBOS `convTurn`, правила, карточки, команды, напоминания), `mind/` (загрузка `sara-mind`, индекс `core.mind_index`, поиск, досье), `history/` (выгрузка), `exam/` (экзамен). Части связаны через контракты zod в `packages/shared` и типы `apps/core/src/conversation/types.ts`, которые часть 0 кладёт первой вместе с заглушками по точным путям; остальные части заменяют тела заглушек.

**Tech Stack:** TypeScript (Node 24), Drizzle (Postgres 16 с pgvector, схемы `core` и `node`), DBOS 5.3 (`registerWorkflow`, `runStep`, `recv`, `send`, `sleep`), grammY, `claude -p` через шлюз, zod 4, vitest 5, `node:sqlite` для снимка v1, `yaml` для полей разума.

**Spec:** `docs/superpowers/specs/2026-10-25-m4-conversation-design.md` (дальше «дизайн»), ADR-024, спецификация `docs/spec/2026-10-22-sara-spec-v1.md`.

## Global Constraints

- Тень: пока `conv.v1_writes` включено (по умолчанию), ни одного вызова `profi.send_message` и ни одной записи `outbox` вида `message`, даже для текста Бориса. Сара сама отправляет только при `conv.v1_writes` выключенном и `outbound.messages` (пауза «Пишет клиентам») включённом; текст, продиктованный Борисом, проходит паузу, но не тень (дизайн 5.8). Тесты отправки идут в режиме «после переключения».
- `conv.v1_writes` включено по умолчанию: сообщение специалиста без доказательства это `author: unknown`, `author_basis: v1_or_boris`, владелец не меняется (ADR-024).
- Ядро никогда не пишет в папку разума: всё, что Сара предлагает в разум, идёт строками `core.mind_proposal` (дизайн 5.2); файлы в `sara-mind` выкладывает и коммитит только разработка командами `mind:proposals` и `mind:accept`.
- Тексты Борису и клиентам по-русски, простым языком, без длинного тире U+2014 и среднего U+2013. В коде эти символы только как `\u2014`, `\u2013` (`pnpm check` ищет U+2014 в `apps`, `packages`, `roles`, `tests`, `scripts`).
- Имя теста начинается с номера требования: `it('FR-CONV-7: …')`. Номера: FR-CONV-1..12, FR-MIND-1..4, FR-SPEECH-2, FR-SPEECH-3, FR-TRAIN-1, FR-TRAIN-8, FR-AUTO-2, FR-OPS-1, FR-OPS-3, FR-OPS-4, NFR-REL-3, NFR-REL-4, NFR-PRIV-2, NFR-UX-1.
- Время в базе UTC; «день», «ночь», «тихие часы» по Москве (`Europe/Moscow`).
- События журнала без текста и имени клиента, только номера (ADR-022).
- Роли без инструментов, только через `Gateway.call`; имя клиента всегда в `redact.names`.
- `WORKFLOW_VERSION` остаётся `'1'`. Новые процессы: `convTurn`, `convRemind` (новые имена). Шаги внутри новых процессов не трогают старые.
- Миграцию добавляет только часть 0 (`0008_conversation`); другим частям новые колонки не нужны. Если `main` уже ушёл дальше 0007, номер берётся следующий и миграция генерируется заново (`pnpm --filter @sara/core exec drizzle-kit generate --name conversation`), ручной SQL дописывается в неё.
- Тесты: своя база Postgres на свободном порту 54371-54379 (`docker run -d --name sara-pg-m4-<часть> -p <порт>:5432 -e POSTGRES_USER=sara -e POSTGRES_PASSWORD=sara -e POSTGRES_DB=sara pgvector/pgvector:pg16`), `DATABASE_URL=postgres://sara:sara@localhost:<порт>/sara`; общую базу на 54329 и Plane не трогать. Перед пул-реквестом `pnpm test` и `pnpm check` зелёные, а новый CLI запускается один раз под `node --import tsx` как на сервере.
- Ни один тест не ходит на живой Профи.ру и не вызывает настоящий Claude (`tests/fakes/fake-claude.mjs`, `FAKE_CLAUDE_OUTPUT_BY_ROLE`).
- Границы M4: `apps/core/src/{conversation,mind,history,exam}/`, `roles/{interlocutor,checker,reminder,examiner}/`, `tests/exam/`, `tests/e2e/conversation*.test.ts`. Общие файлы только по списку дизайна, раздел 12; `apps/core/src/leads/` и `notify/cards.ts` не трогаются, кроме одной строки фильтра в `leads/outbox.ts` (Task 0.3).
- Коммиты Conventional Commits по-английски с `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. Клиент пишет три сообщения подряд, ход уже ждёт: одна реплика, один черновик, ни одного второго процесса. Тест в Task C3.
2. Новое сообщение клиента приходит, когда ход уже прошёл решение, но ещё не закончился: следующий ход стартует сам из `handoff`. Тест в Task C3.
3. Сообщение специалиста появилось во время хода в тени: ход закрыт сравнением, владелец не изменился; после переключения тот же случай делает клиента клиентом Бориса и отменяет ход. Тест в Task C1 и C3.
4. Число в ответе (цена «50 000», срок «2 недели») есть в тексте клиента, но нет в записях знания: проверка `facts.numbers` проваливает, если число не названо клиентом в этой реплике. Тест в Task D1.
5. Переход через полночь по Москве: последнее наше сообщение в 23:50, ответ в 00:10 должен здороваться; в 00:10 и 23:50 одного дня по UTC, но разных по Москве. Тест в Task D1 (`isNewMoscowDay`).

---

## Волны и кто что делает

| Волна | Части | Кто | База |
|---|---|---|---|
| 1 | 0 (контракты, миграция, типы, заглушки, ADR) | основная сессия M4 | ветка `claude/m4-conversation-2cad67` от `main` |
| 2 | A (история), B (разум и поиск), D (проверка и роли), G (служба: событие и фальшивая служба) | по одному субагенту на часть, каждый в своём git worktree и со своей базой | ветка от части 0 |
| 3 | C (разговор и ход) | основная сессия M4 | ветка от части 0 |
| 4 | E (напоминания), F (экзамен), B2 (векторы, если замер дешёвый) | субагенты | ветка от C (E, F) или от B (B2) |

Каждая часть: свой пул-реквест в `main` (зелёный CI, не сливать, не выкладывать), до него один свежий проверяющий субагент на opus по всей части, его критичные и важные находки исправляются тестом первым. Пока часть 0 не слита, пул-реквест волны 2 включает её коммиты; в описании «зависит от #N».

## Карта интерфейсов (что видят соседние части)

Все типы ниже кладёт часть 0. Тела помеченных «заглушка» функций пишут указанные части; подписи не меняются.

| Файл | Экспорт | Тело пишет |
|---|---|---|
| `packages/shared/src/contracts/conversation.ts` | `MessageSide`, `CHAT_AUTHORS`, `ChatAuthor`, `AUTHOR_BASES`, `AuthorBasis`, `TOPICS`, `Topic`, `LOCKED_TOPICS`, `TONES`, `Tone`, `MOVES`, `Move`, `CONV_STAGES`, `ConvStage`, `InterlocutorOutput`, `CheckerOutput`, `ReminderOutput`, `ExaminerOutput`, `CHECK_IDS`, `CheckId`, `CHECK_SEVERITY`, `ExamScenario` | 0 |
| `packages/shared/src/contracts/mind.ts` | `MIND_TYPES`, `MindType`, `MIND_ID_PREFIX`, `MindFrontmatter` (версия 2) | 0 |
| `apps/core/src/conversation/types.ts` | `StoredMessage`, `ConversationRow`, `MindHit`, `Recall`, `MindSearch`, `Dossier`, `DossierMessage`, `CheckInput`, `CheckIssue`, `PolicySettings`, `Decision`, `TurnInput`, `TurnPlan`, `EngineDeps` | 0 |
| `apps/core/src/mind/search.ts` | `createMindSearch(db: Db): MindSearch` (заглушка: пустые ответы, `version()` = `'empty'`) | B |
| `apps/core/src/mind/indexer.ts` | `ensureMindIndex(db: Db, mindDir: string): Promise<{ mindVersion: string; records: number; changed: boolean }>` (заглушка: `{ mindVersion: 'empty', records: 0, changed: false }`) | B |
| `apps/core/src/conversation/check/codeChecks.ts` | `checkReplyText(i: CheckInput): CheckIssue[]` (заглушка: `[{ id: 'empty', detail: 'проверка ещё не построена' }]`), `isNewMoscowDay(lastOursAt: string \| null, now: Date): boolean` (заглушка: `true`) | D |
| `apps/core/src/conversation/check/checkerRole.ts` | `runCheckerRole(gw: Gateway, i: { dossierText: string; facts: MindHit[]; borisWords: string[]; draft: string; names: string[] }): Promise<{ issues: CheckIssue[]; ran: boolean; modelCallId: string \| null }>` (заглушка: `{ issues: [], ran: false, modelCallId: null }`) | D |
| `apps/core/src/conversation/engine.ts` | `planTurn(deps: EngineDeps, input: TurnInput): Promise<TurnPlan>` (заглушка: бросает `Error('engine is not built')`) | C |
| `apps/core/src/profi/client.ts` | `ProfiClient.readChat`, `listChats`, `getOrder`, `sendMessage` | 0 |

Подписи типов `conversation/types.ts` (часть 0 пишет ровно их):

```ts
export type StoredMessage = {
  id: string; accountId: string; chatId: string; orderId: string | null
  platformMessageId: string; side: MessageSide; author: ChatAuthor; authorBasis: AuthorBasis
  text: string; sentAt: string; approxTime: boolean; read: boolean
  source: 'node' | 'v1' | 'telegram_export'; conversationId: string | null; heardAt: string | null
}
export type ConversationRow = {
  id: string; accountId: string; chatId: string; orderId: string | null; dealId: string | null
  origin: 'sara' | 'v1'; owner: 'sara' | 'boris' | 'paused'; ownerReason: 'take' | 'wrote' | 'topic' | null
  borisNote: string | null; closedAt: string | null; handledThrough: string | null
  lastClientHeardAt: string | null; typingAt: string | null; unclearCount: number
}
export type MindHit = {
  id: string; type: MindType; scope: string; title: string; body: string
  topic: Topic | null; tones: Tone[]; stages: ConvStage[]
  exampleClient: string | null; exampleBoris: string | null; rank: number
}
export type Recall = {
  mindVersion: string
  understanding: MindHit[]; knowledge: MindHit[]; examples: MindHit[]
  procedure: MindHit | null; always: MindHit[]
}
export type MindSearch = {
  version(): Promise<string>
  search(q: { text: string; scope: string; types: MindType[]; limit: number; field?: 'body' | 'example_client' }): Promise<MindHit[]>
  byIds(ids: string[]): Promise<MindHit[]>
  byStage(stage: ConvStage, scope: string): Promise<MindHit | null>
  bannedPhrases(): Promise<string[]>
}
export type DossierMessage = { author: ChatAuthor; side: MessageSide; text: string; sentAt: string; platformMessageId: string }
export type Dossier = {
  conversationId: string; accountId: string; scope: string
  order: { title: string; category: string; city: string; budgetText: string | null; text: string } | null
  clientName: string | null; clientInfo: ClientInfo | null
  bid: { text: string; author: ChatAuthor } | null
  messages: DossierMessage[]
  turnMessageIds: string[]
  borisNote: string | null; stage: ConvStage; owner: ConversationRow['owner']; ownerReason: ConversationRow['ownerReason']
  newDay: boolean; night: boolean; lastOursAt: string | null; remindersSent: number
}
export type CheckInput = {
  text: string | null; move: Move; factIds: string[]; recalledIds: string[]
  knowledgeTexts: Record<string, string>; newDay: boolean; clientTurnText: string
  ourPrevious: string[]; bannedPhrases: string[]
}
export type CheckIssue = { id: CheckId; detail: string }
export type PolicySettings = {
  v1Writes: boolean; outboundMessages: boolean; accountPaused: boolean; night: { from: number; to: number }
  autonomy: Record<Topic, 'self' | 'draft' | 'call'>
}
export type Decision = {
  action: 'send' | 'draft' | 'call_boris' | 'forward' | 'hold' | 'nothing'
  would: 'send' | 'call_boris' | 'nothing' | 'forward' | 'hold' | 'draft'
  reason: string; holdUntil: string | null
}
export type TurnInput = { dossier: Dossier; names: string[]; settings: PolicySettings; now: Date }
export type TurnPlan = {
  recall: Recall; output: InterlocutorOutput | null; issues: CheckIssue[]; attempts: number
  decision: Decision; modelCallIds: string[]; checkerRan: boolean; failure: string | null
}
export type EngineDeps = { gateway: Gateway; mind: MindSearch }
```

---

## Часть 0. Контракты, миграция, типы, заглушки

### Task 0.1: Общие контракты M4

**Files:**
- Create: `packages/shared/src/contracts/conversation.ts`, `packages/shared/test/conversation.test.ts`
- Modify: `packages/shared/src/contracts/mind.ts`, `packages/shared/src/contracts/profi.ts`, `packages/shared/src/contracts/settings.ts`, `packages/shared/src/contracts/eventTypes.ts`, `packages/shared/src/contracts/telegram.ts`, `packages/shared/src/index.ts`, `packages/shared/test/contracts.test.ts`, `packages/shared/test/profi.test.ts`

**Interfaces:**
- Produces: всё из строк `packages/shared` карты интерфейсов; `SendMessageInput` (`account_id`, `chat_id`, `text` 1..4000, `expect_last_message_id: string | null`, `idempotency_key`, `permit`), `SendMessageOutput` (`found_on_page`, `platform_message_id: string | null`), `PROFI_TOOLS['profi.send_message']`, класс ошибки `CHAT_CHANGED` в `PROFI_ERROR_CLASSES`, события `profi.specialist_message` (`MessageRef`), `profi.client_typing` (`{ chat_id, at }`), `profi.client_read` (`{ chat_id, platform_message_id: string | null, at }`); настройки дизайна 5.16; события дизайна 5.16; действия кнопок `good`, `close`.

- [ ] **Step 1: Write the failing tests**

```ts
it('FR-CONV-3: the Interlocutor answer keeps the thinking order and cites mind ids', () => {
  expect(Object.keys(InterlocutorOutput.shape)).toEqual([
    'heard', 'question_type', 'topic', 'tone', 'move', 'urgent', 'why', 'text', 'fact_ids', 'example_ids', 'missing',
  ])
  expect(InterlocutorOutput.safeParse({ ...ok, fact_ids: Array(13).fill('k-a') }).success).toBe(false)
})
it('FR-AUTO-2: price, contract, discount and NDA are the locked topics', () => {
  expect([...LOCKED_TOPICS]).toEqual(['price', 'contract', 'discount', 'nda'])
})
it('FR-CONV-4: every check has a severity and a fact outside the mind is S1', () => {
  for (const id of CHECK_IDS) expect(CHECK_SEVERITY[id]).toMatch(/^S[123]$/)
  expect(CHECK_SEVERITY['facts.numbers']).toBe('S1')
  expect(CHECK_SEVERITY['greeting.missing']).toBe('S2')
})
it('FR-MIND-1: version 2 fields are optional, so a version 1 record still parses', () => {
  expect(MindFrontmatter.safeParse(v1Record).success).toBe(true)
  expect(MindFrontmatter.safeParse({ ...v1Record, tones: ['joke'], topic: 'price' }).success).toBe(true)
  expect(MindFrontmatter.safeParse({ ...v1Record, tones: ['sad'] }).success).toBe(false)
})
it('FR-TRAIN-8: an exam scenario needs an id x-…, at least one message and an expected move', () => { … })
it('FR-CONV-10: specialist message, typing and read events carry no text', () => {
  expect(PROFI_EVENT_PAYLOADS['profi.specialist_message'].safeParse({ ...ref, text: 'привет' }).success).toBe(false)
})
it('FR-CONV-5: conversation settings have the design defaults', () => {
  expect(SETTINGS['conv.v1_writes'].default).toBe(true)
  expect(SETTINGS['conv.quiet_after_message_s'].default).toBe(45)
  expect(SETTINGS['conv.quiet_after_typing_s'].default).toBe(20)
  expect(SETTINGS['conv.max_wait_s'].default).toBe(600)
  expect(SETTINGS['conv.night'].default).toEqual({ from: 23, to: 8 })
  expect(SETTINGS['conv.reminder_quiet'].default).toEqual({ from: 23, to: 9 })
  expect(SETTINGS['conv.cards_per_day'].default).toBe(10)
  expect(SETTINGS['conv.reminders'].default).toBe(true)
  expect(SETTINGS['mind.vectors'].default).toBe(false)
  expect(SETTINGS['conv.autonomy'].schema.safeParse({ price: 'self' }).success).toBe(false)
})
```

- [ ] **Step 2: Run** `pnpm vitest run --project shared` → FAIL (модули и ключи не найдены).
- [ ] **Step 3: Implement.** Значения из дизайна 5.2 (темы, тоны, этапы), 5.6 (номера проверок и тяжести; проверки Проверяющего: `checker.unsupported` S1, `checker.contradicts` S1, `checker.robotic` S3, `checker.promises` S1), 5.13 (сценарий), 5.14 (выходы ролей), 5.16 (настройки, события). `MessageSide` это существующий `MessageAuthor`. `InterlocutorOutput`: `heard { said ≤600, behind ≤600 }`, `question_type` строка или null, `why` ≤300, `text` ≤1500 или null, `fact_ids` до 12, `example_ids` до 8, `missing` ≤300 или null. `CheckerOutput`: четыре поля, массивы до 5 строк ≤200, `contradicts_boris` ≤300 или null. `ReminderOutput`: `text` 1..600, `fact_ids` до 6. `ExaminerOutput`: `tone`, `voice` 1..5, `procedure_ok`, `notes` ≤400. `conv.autonomy`: объект «тема → `self`|`draft`|`call`» с `refine`, запрещающим не `call` у `LOCKED_TOPICS`; по умолчанию все `draft`, закрытые `call`. `MIND_ID_PREFIX`: knowledge `k-`, understanding `u-`, speech `s-`, judgment `j-`, example `e-`. События добавлять в конец списка `EVENT_TYPES` одним блоком с комментарием `// M4`.
- [ ] **Step 4: Run** `pnpm vitest run --project shared` → PASS.
- [ ] **Step 5: Commit** `feat(shared): M4 contracts for conversations, the mind and the exam`

### Task 0.2: Таблицы M4

**Files:**
- Modify: `apps/core/src/db/schema.ts`
- Create: `apps/core/drizzle/0008_conversation.sql` (генерация плюс ручной SQL в начале: `CREATE EXTENSION IF NOT EXISTS vector;`), снимок и журнал drizzle
- Test: `apps/core/test/db/conversationSchema.test.ts`

**Interfaces:**
- Produces: таблицы `conversation`, `chatMessage`, `convTurn`, `mindIndex`, `mindGap`, `mindProposal`, `examRun`, `examResult` в `schema.ts` с полями дизайна 5.15; `mindIndex.tsv` это `tsvector` (customType), `mindIndex.embedding` это `vector(384)` (drizzle `vector`), может быть null. Индексы: уникальный `conversation (account_id, chat_id)`; уникальный `chat_message (account_id, platform_message_id)`; уникальный `mind_proposal (path)`; `chat_message (conversation_id, sent_at)`; GIN на `mind_index.tsv`; `conv_turn (conversation_id, created_at)`; `exam_result (run_id)`.

- [ ] **Step 1: Write the failing test**: после `migrate` вставка двух `chat_message` с одним `(account_id, platform_message_id)` даёт ошибку уникальности; вставка в `mind_index` с `tsv = to_tsvector('russian', 'Стоимость сайта')` находится запросом `tsv @@ plainto_tsquery('russian', 'стоимости')`; `embedding` принимает `'[0,…]'` из 384 чисел.
- [ ] **Step 2: Run** `DATABASE_URL=… pnpm vitest run --project core test/db/conversationSchema.test.ts` → FAIL.
- [ ] **Step 3: Implement** схему и сгенерировать миграцию; ручную строку расширения вставить первой в SQL.
- [ ] **Step 4: Run** тот же тест → PASS; `pnpm vitest run --project core` целиком зелёный (старые тесты не сломаны).
- [ ] **Step 5: Commit** `feat(core): M4 tables for conversations, the mind index and the exam`

### Task 0.3: Типы ядра, заглушки, клиент службы, фальшивая служба

**Files:**
- Create: `apps/core/src/conversation/types.ts`, `apps/core/src/conversation/engine.ts`, `apps/core/src/conversation/check/codeChecks.ts`, `apps/core/src/conversation/check/checkerRole.ts`, `apps/core/src/mind/search.ts`, `apps/core/src/mind/indexer.ts`, `apps/core/src/mind/proposals.ts` (`proposeMind(db: DbOrTx, p: { path: string; content: string; kind: 'example' | 'knowledge' | 'scenario' | 'other'; source: string }): Promise<boolean>`: вставка в `core.mind_proposal`, повтор пути ничего не меняет и даёт false, событие `mind.proposed`; это рабочее тело, не заглушка; `exportProposals(db: Db, toDir: string): Promise<number>` заглушка, бросает `Error('mind proposals export is not built')`, тело пишет B3)
- Modify: `apps/core/src/gateway/roles.ts` (`RoleName` + `'interlocutor' | 'checker' | 'reminder' | 'examiner'`), `apps/core/src/profi/client.ts`, `apps/core/src/leads/outbox.ts` (`resumeQueuedOutbox` только `kind = 'bid'`), `apps/core/src/config.ts` (`mindDir: string`, из `SARA_MIND_DIR`, по умолчанию `<dataDir>/mind`), `apps/profi-node/src/mcp/server.ts` (`sendMessage` в `ProfiToolsImpl`, описание, `case`), `apps/profi-node/src/tools/readTools.ts` (`sendMessage` отказывает `INTERNAL` «Служба не пишет в чаты: отправка сообщений ещё не построена»), `apps/profi-node/src/fake/fakeProfi.ts` (минимальный `sendMessage`: проверка разрешения, повтор по ключу возвращает первый итог)
- Test: `apps/core/test/profiClient.test.ts`, `apps/core/test/conversation/stubs.test.ts`, `apps/profi-node/test/fakeProfi.test.ts` (если есть, иначе рядом с существующими тестами фальшивой службы)

**Interfaces:**
- Produces: `ProfiClient.readChat(accountId: string, chatId: string): Promise<ReadChatOutput>`, `listChats(accountId: string): Promise<ListChatsOutput>`, `getOrder(accountId: string, orderId: string): Promise<GetOrderOutput>`, `sendMessage(i: Omit<SendMessageInput, 'permit'>): Promise<SendMessageOutput>` (разрешение `signPermit(secret, idempotency_key)`); все строки карты интерфейсов с заглушками.

- [ ] **Step 1: Write the failing tests**: `NFR-REL-4: a queued message outbox row is not resumed as a bid` (строка `outbox` вида `message` в состоянии `queued` не попадает в `resumeQueuedOutbox`, счётчик 0); `FR-CONV-9: send_message repeats with one key give one message` (фальшивая служба); `FR-CONV-5: the live node refuses to write into a chat`; `FR-CONV-4: the code checks stub blocks every reply` (заглушка возвращает `empty`, чтобы непостроенная проверка никогда не пропускала текст).
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.** Типы ровно как в карте интерфейсов.
- [ ] **Step 4: Run** `pnpm test` и `pnpm check` → PASS.
- [ ] **Step 5: Commit** `feat(core): M4 types, module stubs and the conversation tools of the Profi client`

### Task 0.4: Документы части 0

**Files:**
- Create: `docs/adr/0024-specialist-authorship.md` (уже написан), дизайн и этот план
- Modify: `docs/architecture/data-dictionary.md` (новые таблицы, дом владельца и чьего хода `conversation`, `chat_message` вместо `message`), `docs/architecture/contracts.md` (C2: `send_message`, три события; C5: `good`, `close`; C6 версия 2), `docs/README.md` (ADR до 024), `CONTRIBUTING.md` (перед выкладкой, меняющей `roles/`, `apps/core/src/conversation/`, `apps/core/src/mind/` или `sara-mind`, на сервере `pnpm exam --compare`, итог в пул-реквест; дизайн 5.13), `docs/ops/runbooks.md` (клон `sara-mind` в `/data/mind` и `git pull` при выкладке; дизайн 5.2)

- [ ] **Step 1:** `pnpm check` → PASS.
- [ ] **Step 2: Commit** `docs: M4 design, plan, ADR-024 and the contracts it changes`
- [ ] **Step 3:** push ветки, пул-реквест «M4 part 0: contracts, tables, stubs» в `main`, ссылка главной сессии.

---

## Часть A. Выгрузка истории (FR-TRAIN-1)

Папка `apps/core/src/history/`. Тесты `apps/core/test/history/`. Данные v1 в тестах только выдуманные.

### Task A1: Снимок базы v1

**Files:** Create `history/v1Snapshot.ts`; Test `history/v1Snapshot.test.ts`

**Interfaces:**
- Produces: `type V1Lead = { orderId: string; clientName: string | null; description: string | null; category: string | null; city: string | null; status: string; draftResponse: string | null; draftResponseOriginal: string | null; respondedAt: string | null; borisWroteText: string | null; borisWroteAt: string | null; takenByBorisAt: string | null; dictatedReply: string | null; proposedReply: string | null; replyApprovedAt: string | null; customerReply: string | null; createdAt: string; updatedAt: string }`; `readV1Snapshot(path: string): { leads: V1Lead[]; startedAt: string }` (`startedAt` = `min(created_at)`); колонки, которых нет в старом файле, читаются как null.

- [ ] **Step 1:** тест строит в папке `mkdtemp` SQLite-файл по схеме v1 (таблица `leads` с подмножеством колонок, без `draft_response_original`) через `node:sqlite` и проверяет: файл открыт только на чтение (запись бросает), отсутствующая колонка даёт null, `startedAt` равно самой ранней `created_at`.
- [ ] **Step 2-4:** FAIL → реализация `new DatabaseSync(path, { readOnly: true })`, список колонок через `pragma table_info(leads)` → PASS.
- [ ] **Step 5: Commit** `feat(core): read old Sara's database snapshot read only`

### Task A2: Правила авторства

**Files:** Create `history/attribution.ts`; Test `history/attribution.test.ts`

**Interfaces:**
- Consumes: `normalizeText` из `@sara/shared` (часть 0, `packages/shared/src/format.ts`).
- Produces: `type AttributionContext = { v1StartedAt: string | null; lead: V1Lead | null; v1Texts: Set<string>; ourOutbox: { text: string; at: string }[]; v1Writes: boolean }`; `attribute(m: { side: MessageSide; text: string; sentAt: string }, c: AttributionContext): { author: ChatAuthor; basis: AuthorBasis }`; `V1_TEMPLATES: string[]` (готовые тексты v1: «Да, давайте созвонимся. Во сколько вам удобно?», оба шаблона `followUpTemplates.js` без имени, начало подтверждения встречи «Отлично, договорились! Встреча:»).

- [ ] **Step 1: Write the failing tests**, по строке таблицы дизайна 5.1 на каждую ветку, плюс:
  - `FR-TRAIN-1: a specialist message with no proof is unknown, never boris`;
  - `FR-TRAIN-1: a bid Boris edited is sara_v1, not his voice` (`draft_response` ≠ `draft_response_original`);
  - `FR-TRAIN-1: Boris's words glued by v1 are found as a paragraph` (`boris_wrote_text` из двух абзацев, сообщение равно второму);
  - `FR-CONV-10: after the switch every specialist message that is not ours is Boris's` (`v1Writes: false`);
  - нормализация: `ё`→`е`, U+2014 и U+2013 → `-`, пробелы схлопнуты, регистр.
- [ ] **Step 2-4:** FAIL → реализация (порядок проверок как в таблице дизайна: `outbox`, затем доказательства Бориса, затем доказательства v1, затем `after_cutover`, иначе `unknown`) → PASS.
- [ ] **Step 5: Commit** `feat(core): attribute specialist messages to Boris, old Sara or nobody`

### Task A3: Выгрузка в `chat_message` и отчёт

**Files:** Create `history/exportHistory.ts`; Test `history/exportHistory.test.ts`

**Interfaces:**
- Consumes: `readV1Snapshot`, `attribute`, таблица `node.raw_message` (тест создаёт её миграциями `apps/profi-node` через `prepareNodeTestDatabase` или своим SQL по `apps/profi-node/src/db/schema.ts`).
- Produces: `type ExportReport = { chats: number; messages: Record<ChatAuthor, number>; unknownSpecialist: number; v1Only: number; borisMessages: number; line: string }`; `exportHistory(db: Db, o: { accountId: string; v1: { leads: V1Lead[]; startedAt: string } | null; telegramV1Texts: Set<string>; v1Writes: boolean }): Promise<ExportReport>`; `line` вида «Нашла 23 диалога, 140 твоих сообщений» (склонения через `plural` из `packages/shared/src/format.ts`).

- [ ] **Step 1: Write the failing tests**:
  - `FR-TRAIN-1: node messages land in chat_message with side, author and basis`;
  - `FR-TRAIN-1: a repeated export adds nothing`;
  - `FR-TRAIN-1: a chat the node never read gets v1-only messages with approx_time`, номер `v1:<заказ>:<вид>:<n>`;
  - `FR-TRAIN-1: a real message replaces the v1-only copy with the same text` (сначала выгрузка без чата в `node`, потом с ним);
  - `FR-TRAIN-1: the report line counts Boris's messages`;
  - событие `history.exported` в журнале без текста.
- [ ] **Step 2-4:** FAIL → реализация → PASS.
- [ ] **Step 5: Commit** `feat(core): export the chat history with authors separated`

### Task A4: Образцы речи в предложения разума

**Files:** Create `history/speechProposals.ts`; Test `history/speechProposals.test.ts`

**Interfaces:**
- Consumes: `redact` из `gateway/redact.ts`, `MindFrontmatter`, `proposeMind` из `mind/proposals.ts` (часть 0, Task 0.3).
- Produces: `proposeSpeechExamples(db: Db, o: { accountId: string; minLength?: number }): Promise<{ proposed: number; skipped: number }>`: каждое `author: boris` длиннее 15 знаков с предыдущими сообщениями клиента той же реплики; строка `core.mind_proposal` вида `example` с путём `mind/proposals/shared/speech/examples/e-h-<номер площадки без небуквенных знаков>.md` и полным текстом файла; поля: `type: example`, `scope: shared`, `status: proposal`, `version: 1`, `sources: ['history:<аккаунт>:<номер>']`, `valid_from` сегодня, `valid_to: null`, `stages` по этапу, если известен; тело `## Клиент` и `## Борис`; имя клиента (из `core.lead.client_name` или снимка v1), телефоны, почта, ссылки и `@` заменены метками.

- [ ] **Step 1: Write the failing tests**: `NFR-PRIV-2: a speech example holds no client name, phone, e-mail or link`; `FR-SPEECH-2: only Boris's messages become examples` (`unknown` и `sara_v1` пропущены); `FR-MIND-3: examples become proposals, never mind records`; повторный запуск не плодит строки (уникальный путь); текст предложения, записанный файлом, проходит `checkMind` из `scripts/mind-check.ts`.
- [ ] **Step 2-4:** FAIL → реализация → PASS.
- [ ] **Step 5: Commit** `feat(core): Boris's past messages become speech example proposals`

### Task A5: Выгрузка Telegram и команда

**Files:** Create `history/telegramExport.ts`, `history/exportCli.ts`; Modify `apps/core/package.json` (`"history:export": "tsx src/history/exportCli.ts"`), корневой `package.json` (`"history:export": "pnpm --filter @sara/core history:export"`), `docs/ops/runbooks.md` (раздел «Выгрузка истории»); Test `history/telegramExport.test.ts`

**Interfaces:**
- Produces: `readTelegramV1Texts(path: string): Set<string>`: из `result.json` Telegram Desktop берёт сообщения бота, начинающиеся с «🤖», «🔁», «✅ Отклик отправлен», и вынимает текст, ушедший клиенту (после первой пустой строки, нормализованный); CLI: `--v1 <путь>`, `--telegram <путь>`, `--account <id>` (по умолчанию первый из `SARA_ACCOUNTS`); печатает отчёт, затем число предложений.
- [ ] **Step 1-4:** тест на выдуманном `result.json` (текст сообщения бывает строкой и массивом частей) → реализация → PASS; CLI один раз под `node --import tsx` на тестовой базе с выдуманным снимком.
- [ ] **Step 5: Commit** `feat(core): history:export command with the optional Telegram export`

---

## Часть B. Разум и поиск (FR-MIND-1..4)

Папка `apps/core/src/mind/`. Тесты `apps/core/test/mind/`. Зависимость `yaml` (версия как в корневом `package.json`) добавляется в `apps/core`.

### Task B1: Загрузка файлов разума

**Files:** Create `mind/loader.ts`; Modify `scripts/mind-check.ts` (уникальность `id`, префикс по типу, поля версии 2); Test `mind/loader.test.ts`, `scripts/test/mind-check.test.ts`

**Interfaces:**
- Produces: `type MindRecord = { path: string; front: MindFrontmatter; title: string; body: string; sections: Record<string, string> }`; `loadMind(dir: string): Promise<{ records: MindRecord[]; mindVersion: string; errors: { path: string; message: string }[] }>`: читает `mind/shared/**` и `mind/directions/**` (не `proposals/`), поля между `---`; `title` из поля или первого заголовка; `sections` по заголовкам `## …`; `mindVersion` = `git rev-parse HEAD` в `dir`, если это git, иначе первые 12 знаков sha256 от отсортированных путей и содержимого; нет папки: пустой список и `'empty'`.

- [ ] **Step 1:** тесты: `FR-MIND-3: proposals are never loaded`; `FR-MIND-1: the mind version changes when a confirmed file changes`; запись с неверным полем попадает в `errors` с путём и полем, остальные загружаются; `mind:check` ловит повтор `id` и `k-` у записи типа `understanding`.
- [ ] **Step 2-4:** FAIL → реализация → PASS.
- [ ] **Step 5: Commit** `feat(core): load the mind files with their version`

### Task B2: Индекс и поиск

**Files:** Modify `mind/indexer.ts`, `mind/search.ts` (тела заглушек); Test `mind/search.test.ts`

**Interfaces:**
- Consumes: `loadMind`.
- Produces: тела `ensureMindIndex` и `createMindSearch` по карте интерфейсов. Индексируются только `status: confirmed` и сегодня в `[valid_from, valid_to]` (по Москве). `tsv`: `setweight(to_tsvector('russian', title || tags), 'A') || setweight(to_tsvector('russian', body), 'B')`; для образцов отдельно `example_client`, поиск с `field: 'example_client'` идёт по `to_tsvector('russian', example_client)`. Запрос: слова длиной от 3 знаков, каждое через `plainto_tsquery('russian', слово)`, соединённые `||`; ранг `ts_rank_cd`; область `shared` или равная `scope`. `bannedPhrases()` это пункты списка раздела «Никогда не говорит» записи `s-portrait` (строки, начинающиеся с «- »). `ensureMindIndex` перестраивает индекс в одной транзакции, только если `mindVersion` отличается от записанной, и пишет событие `mind.indexed`.

- [ ] **Step 1: Write the failing tests**:
  - `FR-MIND-2: a client question about the price finds the price record by Russian word forms` («сколько стоит сайт» находит запись «Стоимость сайтов»);
  - `FR-MIND-2: search answers under 300 ms on 1000 records` (1000 сгенерированных записей, 20 запросов, худший меньше 300 мс);
  - `FR-MIND-3: a proposal and an outdated record are not found`;
  - `FR-MIND-1: a direction record is found only for its account`;
  - `FR-SPEECH-2: examples are searched by what the client wrote`;
  - `ensureMindIndex` второй раз с той же версией возвращает `changed: false`.
- [ ] **Step 2-4:** FAIL → реализация → PASS.
- [ ] **Step 5: Commit** `feat(core): the mind index and Russian full-text search`

### Task B3: Команды разума и пробелы знания

**Files:** Create `mind/cli.ts`, `mind/gaps.ts`; Modify `mind/proposals.ts` (тело `exportProposals`), `apps/core/package.json` (`"mind": "tsx src/mind/cli.ts"`), корневой `package.json` (`"mind:index": "pnpm --filter @sara/core mind index"`, `"mind:proposals": "pnpm --filter @sara/core mind proposals"`, `"mind:accept": "pnpm --filter @sara/core mind accept"`); Test `mind/gaps.test.ts`, `mind/cli.test.ts`, `mind/proposals.test.ts`

**Interfaces:**
- Produces: `exportProposals(db: Db, toDir: string): Promise<number>` (строки `new` пишутся файлами по своему пути внутри `toDir`, состояние `exported`); `mind proposals --to <клон sara-mind>`; `mind index` (печатает версию и число записей); `mind accept <путь внутри proposals>…`: переносит файл из `proposals/` в то же место без `proposals/`, меняет `status` на `confirmed`, коммитит в `sara-mind` сообщением `mind: accept <id> (Boris said yes)`, если папка это git; `recordGap(db: Db, i: { turnId: string; text: string; topic: Topic }): Promise<void>`; `topGap(db: Db, sinceDays: number): Promise<{ text: string; count: number } | null>` (группировка по нормализованному тексту).
- [ ] **Step 1-4:** тесты `FR-MIND-3: accept moves a proposal into the mind and confirms it`; `FR-MIND-3: exported proposals are written once and marked exported`; `FR-MIND-4: the most frequent gap of the week is chosen` → реализация → PASS; CLI один раз под `node --import tsx`.
- [ ] **Step 5: Commit** `feat(core): mind index and accept commands, knowledge gaps`

### Task B4: Стартовое содержимое `sara-mind`

Репозиторий `~/sara-mind` (свой worktree или ветка `m4-start`), свой пул-реквест в `natadvn-hance/sara-mind`.

**Files:** `mind/shared/judgment/constitution.md` (`j-constitution`), `mind/shared/judgment/autonomy.md` (`j-autonomy`), `mind/shared/judgment/stages/{bid_sent,talking,call_proposed}.md` (`j-stage-…`), `mind/shared/speech/portrait.md` (`s-portrait`), `mind/shared/understanding/*.md` (5-8 типов вопросов из переговорщика v1: цена, сроки, «пришлите КП», «есть ли кейсы», согласие на созвон, «подумаю», «ты бот?», торг), `mind/shared/knowledge/*.md` (о Hance из открытых источников: что делает Hance, подход, город), `README.md` (формат записей версии 2).

- Статус `confirmed` только у записей, целиком составленных из правил, которые Борис уже сказал словами, с датой и местом в `sources` (дизайн 5.2: цель созвон, не звонить самой, приветствие на новом дне и не здороваться заново, без тире, простым языком, не цитировать, без перечня услуг, тон, цена и договор и скидки и NDA у Бориса, ценности Hance из `COMPANY_VALUES` v1 от 12.09.2026). Процедуры этапов, портрет, понимание и знание кладутся в `mind/proposals/…` со статусом `proposal`.
- [ ] **Step 1:** `pnpm mind:check ~/sara-mind/mind` → PASS.
- [ ] **Step 2:** `SARA_MIND_DIR=~/sara-mind pnpm mind:index` на тестовой базе → число записей больше 0.
- [ ] **Step 3: Commit** в `sara-mind`: `feat: the rules Boris already gave and first proposals`; пул-реквест в `sara-mind`.

### Task B5 (волна 4): векторы, если дёшево

**Files:** Create `mind/embedder.ts`; Modify `mind/indexer.ts`, `mind/search.ts`; Test `mind/vectors.test.ts`

**Interfaces:**
- Produces: `type Embedder = { embed(texts: string[], kind: 'query' | 'passage'): Promise<number[][]> }`; `createE5Embedder(cacheDir: string): Embedder` (`@huggingface/transformers`, `Xenova/multilingual-e5-small`, префиксы `query: `, `passage: `, нормализованный средний пул); `fakeEmbedder` для тестов (детерминированные векторы от хеша слов). Поиск при `mind.vectors` сливает списки методом RRF (`1 / (60 + ранг)`).
- [ ] **Step 0 (замер):** скрипт в папке scratchpad: загрузка модели, 50 запросов; записать время и прирост размера `node_modules`. Если запрос дольше 150 мс или прирост больше 300 МБ: задача закрывается записью в журнале части, векторы не строятся.
- [ ] **Step 1-4:** тест `FR-MIND-2: with vectors on, a synonym finds the record full-text misses` на `fakeEmbedder` → реализация → PASS.
- [ ] **Step 5: Commit** `feat(core): local vectors for the mind search behind mind.vectors`

---

## Часть D. Проверка и роли (FR-CONV-4, FR-SPEECH-3)

### Task D1: Проверка кодом

**Files:** Modify `conversation/check/codeChecks.ts` (тела заглушек); Create `conversation/check/phrases.ts` (встроенный список роботных фраз, слов про ИИ, обещаний); Test `apps/core/test/conversation/codeChecks.test.ts`

**Interfaces:**
- Consumes: `CheckInput`, `CheckIssue`, `CHECK_IDS`.
- Produces: `checkReplyText(i: CheckInput): CheckIssue[]` по таблице дизайна 5.6; `isNewMoscowDay(lastOursAt: string | null, now: Date): boolean` (null → true; сравнение дат в `Europe/Moscow`); `startsWithGreeting(text: string): boolean` (с именем впереди: «Анна, здравствуйте»); `extractNumbers(text: string): string[]` (числа с пробелами внутри «50 000», дроби, проценты; без времени вида 15:30 и телефонов).

- [ ] **Step 1: Write the failing tests** (по одному на номер проверки, плюс):
  - `FR-CONV-4: a price not in the cited knowledge fails facts.numbers`;
  - `FR-CONV-4: a number the client named in this turn is allowed`;
  - `FR-CONV-3: a reply without any mind id fails facts.none`;
  - `FR-CONV-4: a new Moscow day needs a greeting, the same day forbids it` (23:50 и 00:10 по Москве);
  - `FR-CONV-4: a long or medium dash anywhere fails` (символы через `\u2014`, `\u2013`);
  - `FR-CONV-4: Sara never promises to call` («Я вам перезвоню завтра», «наберу вас»);
  - `FR-CONV-4: banned phrases from the portrait are robotic`;
  - `FR-CONV-4: move none and call_boris need no text`.
- [ ] **Step 2-4:** FAIL → реализация → PASS.
- [ ] **Step 5: Commit** `feat(core): the code checks of a reply`

### Task D2: Роли Собеседник и Проверяющий

**Files:** Create `roles/interlocutor/{role.md,meta.json,evals/samples.json}`, `roles/checker/{role.md,meta.json,evals/samples.json}`; Modify `conversation/check/checkerRole.ts` (тело); Test `apps/core/test/conversation/checkerRole.test.ts`

**Interfaces:**
- Produces: `meta.json` Собеседника `{ name: interlocutor, version: 1, model: sonnet, fallbackModel: opus, priority: P0, timeoutMs: 120000 }`; Проверяющего `{ checker, 1, haiku, fallback sonnet, P0, 60000 }`. Инструкции по дизайну 5.14 и переговорщику v1 (`negotiatorPrompt.js`, только чтение). Вход Собеседника (формат пишет часть C в `engine.ts`) читается ролью по заголовкам: «Заказ», «Клиент», «Отклик», «Переписка», «Реплика клиента», «Указание Бориса», «Флаги», «Записи разума», «Образцы Бориса», «Переделать» (последний только при повторе). `runCheckerRole` превращает `CheckerOutput` в `CheckIssue[]` (`checker.unsupported` на каждое утверждение и так далее); сбой шлюза даёт `{ issues: [], ran: false }`.
- [ ] **Step 1:** тесты с фальшивым CLI: `FR-CONV-4: the Checker's unsupported claim becomes an S1 issue`; `FR-CONV-4: a failed Checker call does not pass the reply silently` (`ran: false`); имя клиента ушло в шлюз меткой (лог аргументов фальшивого CLI не содержит имени).
- [ ] **Step 2-4:** FAIL → реализация → PASS. `evals/samples.json`: по 8 входов с ожидаемым ходом и темой (выдуманные, без данных клиентов).
- [ ] **Step 5: Commit** `feat(roles): the Interlocutor and the Checker`

### Task D3: Роли напоминания и судьи экзамена

**Files:** Create `roles/reminder/{role.md,meta.json}`, `roles/examiner/{role.md,meta.json}`; Test `apps/core/test/conversation/roles.test.ts`

- `reminder`: sonnet, P1, 120000; приветствие всегда, без кейсов, обычный или дружеский тон (v1 `followUpPrompt.js`), без канцелярита «просто хотела уточнить», «напоминаю о себе», не дословно прошлое сообщение. `examiner`: sonnet, fallback opus, P3, 120000; рубрика тона и голоса 1-5 с примерами, `procedure_ok`.
- [ ] **Step 1-4:** тест `NFR-UX-1: role texts have no long dash and every role loads` (`loadRole` для четырёх новых ролей, `RoleMeta` парсится) → PASS.
- [ ] **Step 5: Commit** `feat(roles): the reminder writer and the exam judge`

---

## Часть G. Служба Профи-MCP

### Task G1: Событие о сообщении специалиста

**Files:** Modify `apps/profi-node/src/eyes/eyes.ts` (одно место: строка `if (!isNew || history || m.author === 'specialist' || m.author === 'system') return`); Test `apps/profi-node/test/eyes.test.ts`

- Новое сообщение специалиста (не история) ставит в очередь `profi.specialist_message` с `MessageRef`; системное по-прежнему без события.
- [ ] **Step 1-4:** тест `FR-CONV-10: a new specialist message is shipped as an event without text`; история и повтор без события → реализация → PASS.
- [ ] **Step 5: Commit** `feat(profi-node): tell the core about specialist messages`

### Task G1b: Порядок сообщений одного чтения

**Files:** Modify `apps/profi-node/src/eyes/profiParsers.ts` (`fromChatDom`: время сообщения `i` из `n` в одном чтении = момент чтения минус `(n - 1 - i)` мс; время, пришедшее из потока, по-прежнему побеждает в `eyes.onChatRead`), `apps/profi-node/src/tools/readTools.ts` (`readChat` сортирует по `sent_at`, затем по `platform_message_id`); Test тесты разбора и инструментов чтения

- [ ] **Step 1-4:** тест `FR-CONV-2: messages of one chat reading keep the page order` (страница с тремя сообщениями, `readChat` отдаёт их в порядке страницы) → реализация → PASS.
- [ ] **Step 5: Commit** `fix(profi-node): keep the page order of messages read together`

### Task G2: Фальшивая служба с чатами

**Files:** Modify `apps/profi-node/src/fake/fakeProfi.ts`; Test тесты фальшивой службы

**Interfaces:**
- Produces: в `FakeProfi`: `messages: SendMessageInput[]`; `addChatMessage(m: { chatId: string; orderId?: string | null; author: MessageAuthor; text: string; read?: boolean; sentAt?: string }): Promise<{ platformMessageId: string; eventId: string | null }>` (сохраняет в памяти и шлёт `profi.client_message` для клиента, `profi.specialist_message` для специалиста, `profi.author_unclear` для `unknown`); `emitTyping(chatId: string): Promise<void>`; `emitRead(chatId: string, platformMessageId: string): Promise<void>`; `readChat` и `listChats` отвечают из памяти; `sendMessage` добавляет сообщение специалиста с новым номером и возвращает `{ found_on_page: true, platform_message_id }`; повтор ключа без второго сообщения; если `expect_last_message_id` не равен номеру последнего сообщения чата, отказ `CHAT_CHANGED` без сообщения; `failNextSendAck()` теряет ответ после отправки (для теста повтора).
- [ ] **Step 1-4:** тесты на каждый метод → реализация → PASS.
- [ ] **Step 5: Commit** `feat(profi-node): the fake service keeps chats, typing and sent messages`

---

## Часть C. Разговор и ход (FR-CONV-1..11, FR-OPS-4)

Папка `apps/core/src/conversation/`. Тесты `apps/core/test/conversation/` и `tests/e2e/conversation.test.ts`.

### Task C1: Синхронизация чата, разговор, владелец, сверка

**Files:** Create `conversation/store.ts`, `conversation/sync.ts`, `conversation/events.ts`, `conversation/reconcile.ts`; Modify `apps/core/src/accounts/profiEvents.ts` (`routeProfiEvent`: `profi.client_message`, `profi.specialist_message`, `profi.author_unclear`, `profi.client_typing`, `profi.client_read` → `onConversationEvent`); Test `conversation/sync.test.ts`, `conversation/reconcile.test.ts`

**Interfaces:**
- Consumes: `ProfiClient.readChat`, `listChats`, `normalizeText` из `@sara/shared`. Живое авторство здесь своё и короткое (`liveAuthor`: совпадение с исходящей очередью новой Сары → `sara`/`outbox`; `conv.v1_writes` выключено → `boris`/`after_cutover`; иначе `unknown`/`v1_or_boris`); доказательства из снимка v1 есть только у выгрузки (часть A).
- Produces: `ensureConversation(db: Db, i: { accountId: string; chatId: string; orderId: string | null }): Promise<ConversationRow>` (ссылка на `deal` по `lead_id = orderId`, `origin: sara`, если сделка есть, иначе `v1`); `syncChat(d: { db: Db; profi: ProfiClient }, conv: ConversationRow, heardAt: Date): Promise<SyncResult>`; `type SyncResult = { added: StoredMessage[]; specialistAfter: StoredMessage[]; unclear: boolean; messages: StoredMessage[] }`; `applyOwnerRule(db: Db, conv: ConversationRow, added: StoredMessage[], v1Writes: boolean): Promise<ConversationRow>`; `onConversationEvent(e: EventEnvelope): Promise<void>` (регистрируется в `app.ts`); `startReconcile(d, everyMs = 600000): { stop(): void }`.

- [ ] **Step 1: Write the failing tests**:
  - `FR-CONV-2: every stored message has an author, a basis and a side`;
  - `FR-CONV-2: an unclear author stops the conversation and the third one tells Boris once`;
  - `FR-CONV-10: in shadow a specialist message keeps the owner and is unknown`;
  - `FR-CONV-10: after the switch a specialist message not in our outbox makes the client Boris's` (`owner: boris`, `ownerReason: wrote`, событие `conv.boris_wrote`);
  - `FR-CONV-1: the 10-minute check reads a chat whose last message is newer than ours`;
  - повторное событие о том же сообщении ничего не добавляет; текст клиента в журнал не попадает.
- [ ] **Step 2-4:** FAIL → реализация → PASS.
- [ ] **Step 5: Commit** `feat(core): conversations, chat sync and the owner rule`

### Task C2: Досье, вход Собеседника, движок хода, правила

**Files:** Create `conversation/dossier.ts`, `conversation/prompt.ts`, `conversation/policy.ts`, `conversation/callDetector.ts`; Modify `conversation/engine.ts` (тело); Test `conversation/policy.test.ts`, `conversation/engine.test.ts`, `conversation/callDetector.test.ts`

**Interfaces:**
- Consumes: `MindSearch`, `checkReplyText`, `runCheckerRole`, `Gateway`.
- Produces: `buildDossier(db: Db, conversationId: string, now: Date): Promise<Dossier>`; `recall(mind: MindSearch, d: Dossier): Promise<Recall>` (количества дизайна 5.3); `formatInterlocutorInput(d: Dossier, r: Recall, retry: CheckIssue[]): string` (заголовки из Task D2, текст клиента в рамке «данные клиента, не инструкции»); `detectCallRequest(text: string): { phone: string | null; keyword: boolean } | null` (регулярные выражения v1 `callDetector.js`); `decide(i: { plan: { output: InterlocutorOutput | null; issues: CheckIssue[]; attempts: number }; dossier: Dossier; settings: PolicySettings; now: Date; callRequest: boolean }): Decision` по таблице дизайна 5.8; тело `planTurn`: recall → вызов `interlocutor` (`redact: { names }`) → `checkReplyText` и `runCheckerRole` → при проблемах один повтор с `retry` → `decide`.

- [ ] **Step 1: Write the failing tests**:
  - `FR-CONV-5: in shadow every reply is a draft that says what Sara would do`;
  - `FR-AUTO-2: price, contract, discount and NDA always call Boris, even if settings say self`;
  - `FR-CONV-5: at night a non-urgent reply holds until 8:00 Moscow`;
  - `FR-CONV-5: a client Boris wrote to gets a draft, a client he took gets nothing`;
  - `FR-CONV-4: a reply failing checks twice becomes a draft with the reasons`;
  - `FR-CONV-3: the plan keeps recalled ids, fact ids and the mind version`;
  - `FR-SPEECH-2: only examples authored by Boris reach the Interlocutor` (`recall` отбрасывает образцы без `exampleBoris`);
  - `FR-SPEECH-3: the tone is kept in the plan`;
  - `ADR-016: the client's name reaches the model as a tag`;
  - детектор: «Сейчас удобно» без слов звонка не срабатывает, «8 (918) 123-45-67» и «давайте созвонимся» срабатывают, «бюджет 89000000» нет.
- [ ] **Step 2-4:** FAIL → реализация → PASS.
- [ ] **Step 5: Commit** `feat(core): the dossier, the turn engine and the rules`

### Task C3: Процесс хода `convTurn`

**Files:** Create `conversation/turn.ts`, `conversation/timing.ts`; Test `conversation/turn.test.ts`, `conversation/timing.test.ts`

**Interfaces:**
- Consumes: C1, C2, `startTurnCard` из C4 (до C4 шаг карточки пишет только `conv_turn`).
- Produces: `turnWorkflowId(conversationId: string, anchor: string): string` = `conv-turn:<разговор>:<anchor>`; `startTurn(conversationId: string, anchor: string): Promise<void>` (повтор того же номера возвращает существующий процесс); `pokeTurn(conversationId: string): Promise<void>` (`DBOS.send` на текущий ход, `DBOS.send` в несуществующий процесс молча пропускается); `quietLeftSeconds(c: ConversationRow, s: { quietAfterMessageS: number; quietAfterTypingS: number }, now: Date): number`; `humanPauseMs(textLength: number, jitter: number): number` (60 000 + 300 на знак + jitter·30 000, в пределах 60 000..240 000); `nightEnd(now: Date, night: { from: number; to: number }): Date | null`.
- Шаги процесса (имена шагов фиксированы, в цикле с номером круга): `hear-<n>`, `gate`, `recall`, `plan`, `decide`, `card` или (`pause` → `reread` → `send`), `handoff`. Ожидание через `DBOS.recv('poke', { timeoutSeconds })` в цикле до тишины или `conv.max_wait_s`. Трасса `conv_turn` обновляется в конце каждого шага.

- [ ] **Step 1: Write the failing tests**:
  - `FR-CONV-7: three client messages with typing between them get one reply` (E9);
  - `FR-CONV-7: the turn waits while the client types and gives up waiting after max_wait_s`;
  - `FR-CONV-3: a turn leaves a trace of all 8 steps`;
  - `FR-CONV-6: a specialist message during the turn cancels it after the switch`;
  - `FR-CONV-6: the client writing during the pause makes the turn plan again with the whole turn` (режим после переключения, фальшивая служба);
  - `FR-CONV-8: the human pause is between 1 and 4 minutes and grows with length`;
  - `FR-CONV-5: shadow never calls send_message` (счётчик `fake.messages` равен 0 после 5 ходов);
  - `NFR-REL-3: a turn killed while waiting resumes after restart` (как в `apps/core/test/workflows`);
  - Review Focus 2: сообщение клиента между `decide` и `handoff` запускает следующий ход.
- [ ] **Step 2-4:** FAIL → реализация → PASS.
- [ ] **Step 5: Commit** `feat(core): the turn workflow with waiting, the human pause and rereading`

### Task C4: Карточка черновика и сравнение в тени

**Files:** Create `conversation/texts.ts` (`CONV_TEXTS`), `conversation/cards.ts`, `conversation/compare.ts`; Modify `apps/core/src/notify/notifier.ts`, `notify/telegram.ts`, `notify/botControl.ts` (`editText(messageId: number, text: string, rows?: { text: string; callbackData: string }[][]): Promise<void>`, без звука); Test `conversation/cards.test.ts`, `conversation/compare.test.ts`

**Interfaces:**
- Produces: `sendTurnCard(d: { db: Db; notifier: Notifier }, turnId: string): Promise<{ taskId: string; messageId: number } | null>` (задача вида `conv_draft`, кнопки `good`, `edit`, `take`, `close`; null, если превышен `conv.cards_per_day`; ночью без звука по `cards.quiet_hours`); `similarity(a: string, b: string): number` (0..100, трёхбуквенные сочетания после `normalizeText`, Жаккар); `compareTurn(d, turnId: string, actual: StoredMessage): Promise<void>` (пишет `actual_message_id`, `actual_author`, `similarity`, событие `conv.compared`, редактирует карточку).
- [ ] **Step 1: Write the failing tests**: `FR-CONV-3: the draft card shows the draft, what Sara would do and the mind ids`; `FR-NOTIF-3: the 11th card of the day is not sent`; `FR-CONV-10: the real reply edits the card silently with its author and similarity`; `NFR-UX-1: conversation texts have no long dash`; `similarity` одинаковых текстов 100, разных 0.
- [ ] **Step 2-4:** FAIL → реализация → PASS.
- [ ] **Step 5: Commit** `feat(core): the shadow draft card and the comparison with the real reply`

### Task C5: Команды Бориса, API, подключение

**Files:** Create `conversation/commands.ts`, `conversation/routes.ts`; Modify `apps/core/src/app.ts` (создание модулей, `ensureMindIndex(db, config.mindDir)` при запуске, маршрут кнопок: задачи вида `conv_*` в `onConvPress`, остальные в `pipeline.onPress`; сверка; `close()` останавливает сверку), `apps/core/src/learning/inbox.ts` (ответ на карточку разговора и вопросы видов `conv_edit`, `conv_say` в `onConversationReply`); Test `conversation/commands.test.ts`, `tests/e2e/conversation.test.ts`

**Interfaces:**
- Produces: `take(db, conversationId, actor)`, `giveBack(db, conversationId, note: string | null)`, `say(d, conversationId, text)`, `close(db, conversationId)`, `markGood(db, turnId)`, `startEdit(d, turnId)`; `parseCardReply(text: string): { cmd: 'take' } | { cmd: 'return'; note: string | null } | { cmd: 'say'; text: string } | { cmd: 'close' } | { cmd: 'good' } | null`; маршруты `POST /api/conversations/:id/{take,return,say,close}` за `requireSession`.
- [ ] **Step 1: Write the failing tests**: по одному на команду из дизайна 5.10 кнопкой и ответом на карточку (`FR-CONV-11: …`); `FR-NOTIF-1: a command without a card is not guessed`; `FR-CONV-11: in shadow «написать текст» is kept as Boris's answer and not sent`; e2e: заявка не нужна, чат v1 → сообщение клиента в фальшивой службе → карточка черновика в фальшивом Telegram → ответ специалиста → карточка отредактирована; E8 после переключения.
- [ ] **Step 2-4:** FAIL → реализация → PASS; `pnpm test`, `pnpm check`; ядро один раз под `node --import tsx` с фальшивой службой (`pnpm dev`).
- [ ] **Step 5: Commit** `feat(core): Boris's commands for a conversation from the bot and the API`

### Task C6: Отправка после переключения и отчёт

**Files:** Create `conversation/outbox.ts`, `conversation/reportCli.ts`, `conversation/daySummary.ts`; Modify `apps/core/package.json` (`"report:conv": "tsx src/conversation/reportCli.ts"`), корневой `package.json`; Test `conversation/outbox.test.ts`, `conversation/report.test.ts`

**Interfaces:**
- Produces: `queueMessage(tx: DbOrTx, i: { turnId: string; round: number; accountId: string; chatId: string; text: string; author: 'sara' | 'boris' }): Promise<string>` (ключ `msg:<turnId>:<round>`); `deliverMessage(d: { db: Db; profi: ProfiClient }, outboxId: string): Promise<'confirmed' | 'uncertain' | 'failed'>` (передаёт `expect_last_message_id` последнего сообщения, которое видел ход; `CHAT_CHANGED` даёт `'changed'`, и ход идёт заново; после `UNCERTAIN` читает чат и ищет текст среди сообщений специалиста после постановки в очередь; повтор только если его точно нет), возвращает `'confirmed' | 'changed' | 'uncertain' | 'failed'`; `convReport(db: Db, days: number): Promise<string>` (дизайн 5.12); `startConvDaySummary(d: { db: Db; notifier: Notifier; tickMs?: number }): { stop(): void }` (в 20:00 по Москве одно сообщение «Разговоры за день», если день не пустой, раз в день через `core.job_run`, событие `conv.day_summary`).
- [ ] **Step 1: Write the failing tests**: `FR-CONV-9: a lost answer after sending gives no second message`; `FR-CONV-6: the service refusing with CHAT_CHANGED sends nothing and the turn plans again`; `FR-CONV-5: queueMessage refuses in shadow even for Boris's text`; `FR-CONV-5: queueMessage refuses Sara's own text while outbound.messages is off, Boris's text passes`; `FR-OPS-4: the report counts drafts, comparisons by author and check failures`; `FR-NOTIF-3: the evening conversation summary comes once and not on an empty day`.
- [ ] **Step 2-4:** FAIL → реализация → PASS; `report:conv` один раз под `node --import tsx`.
- [ ] **Step 5: Commit** `feat(core): sending after the switch with no duplicates, and the conversation report`

---

## Часть E. Напоминания (FR-CONV-12)

### Task E1: Лестница и процесс `convRemind`

**Files:** Create `conversation/reminders.ts`; Test `conversation/reminders.test.ts`

**Interfaces:**
- Consumes: `syncChat`, `ConversationRow`, `queueMessage`, роль `reminder`.
- Produces: `nextReminder(i: { lastOursAt: string; sent: number; read: boolean; continued: boolean; now: Date }): { at: Date; step: 1 | 2 | 'dormant' | 3 | 4; tone: 'check_in' | 'friendly' } | null` (дизайн 5.11: +24 ч, +72 ч, застой +7 суток, затем по «Напоминать дальше» +10 и +30 суток, последнее дружеское; срок в тихие часы `conv.reminder_quiet` переносится на 9:00); `startReminder(conversationId: string, lastOursMessageId: string): Promise<void>` (процесс `conv-remind:<разговор>:<сообщение>`, запускается из `syncChat`, когда последнее сообщение наше); готовый текст v1 после 3 часов без текста от модели.
- [ ] **Step 1: Write the failing tests**: `FR-CONV-12: no reminder goes if the client answered`; `FR-CONV-12: read and unread clients get different texts`; `FR-CONV-12: after 7 days the client is dormant and Boris gets one task` (в тени задача только в трассе); `FR-CONV-12: a reminder due at night waits until 9:00 Moscow`; `NFR-REL-3: a reminder survives a restart`.
- [ ] **Step 2-4:** FAIL → реализация → PASS.
- [ ] **Step 5: Commit** `feat(core): reminders to clients by the read-aware ladder`

---

## Часть F. Экзамен (FR-TRAIN-8)

Папка `apps/core/src/exam/`, сценарии `tests/exam/scenarios/` и `sara-mind/exam/scenarios/`.

### Task F1: Сценарии руками и загрузка

**Files:** Create `exam/scenarios.ts`, `tests/exam/scenarios/*.json` (30 штук: 18 типичных, 12 трудных по дизайну 5.13, все выдуманные); Test `exam/scenarios.test.ts`

**Interfaces:**
- Produces: `loadScenarios(dirs: string[]): Promise<{ scenarios: ExamScenario[]; setHash: string; errors: { path: string; message: string }[] }>`; `dossierFromScenario(s: ExamScenario): Dossier` (флаги нового дня и ночи по `s.now`).
- [ ] **Step 1-4:** тесты `FR-TRAIN-8: every handmade scenario parses and ids are unique`; `FR-TRAIN-8: 20% or more of the set is hard`; `NFR-PRIV-2: handmade scenarios hold no phone, e-mail or link except the trap ones marked so` → PASS.
- [ ] **Step 5: Commit** `feat(core): exam scenarios and their loader`

### Task F2: Оценка, прогон, сравнение, команды

**Files:** Create `exam/grade.ts`, `exam/run.ts`, `exam/cli.ts`, `exam/build.ts`; Modify `apps/core/package.json` (`"exam": "tsx src/exam/cli.ts"`), корневой `package.json` (`"exam"`, `"exam:build"`); Test `exam/grade.test.ts`, `exam/run.test.ts`

**Interfaces:**
- Consumes: `planTurn`, `dossierFromScenario`, `CHECK_SEVERITY`, роль `examiner`.
- Produces: `gradeScenario(s: ExamScenario, plan: TurnPlan, judge: ExaminerOutput | null): { severity: 'S1' | 'S2' | 'S3' | null; failures: { id: string; severity: string; detail: string }[]; score: number }` (дизайн 5.13: 1,0 − 0,5·S2 − 0,2·S3, 0 при S1; тема из `LOCKED_TOPICS` с решением `send` это S1; ход не тот это S2); `runExam(d: { db: Db; gateway: Gateway; mind: MindSearch }, o: { dirs: string[]; only?: string[]; judge: boolean }): Promise<{ runId: string; score: number; s1: number; passed: boolean }>` (правила в режиме «после переключения»; `passed` = нет S1 и итог не хуже прошлого прогона того же `setHash`); `buildScenarios(db: Db, o: { limit: number }): Promise<number>` (из `chat_message`: реплика клиента и следующий ответ `author: boris`, обезличенно; строки `core.mind_proposal` вида `scenario` с путём `exam/scenarios/x-h-<номер>.json`, `golden: false`). CLI отказывается при `CI=true`.
- [ ] **Step 1: Write the failing tests**: `FR-TRAIN-8: a fact outside the mind fails the scenario as S1`; `FR-TRAIN-8: a worse run than the last one does not pass`; `FR-TRAIN-8: the run stores the mind version and role versions`; `FR-TRAIN-8: the exam refuses to run in CI`; прогон двух ручных сценариев с фальшивым CLI.
- [ ] **Step 2-4:** FAIL → реализация → PASS; `pnpm exam --only <id>` один раз под `node --import tsx` с фальшивым CLI (`SARA_CLAUDE_BIN=tests/fakes/fake-claude.mjs`).
- [ ] **Step 5: Commit** `feat(core): the exam run, grading and the deploy guard`

---

## Самопроверка плана

- Покрытие дизайна: 5.1 → A1-A5; 5.2 → B1, B3, B4; 5.3 → B2, B5; 5.4 → C2; 5.5 → C2, C3; 5.6 → D1, D2; 5.7 → C3; 5.8 → C2; 5.9 → C1, G1; 5.10 → C5; 5.11 → E1; 5.12 → C4, C6; 5.13 → F1, F2; 5.14 → D2, D3; 5.15 → 0.2; 5.16 → 0.1; 5.17 → G1, G2 (живые `send_message` и `backfill_chats` не в M4); 6 → C1, C3, C6; 7 → A4, C2; 8 → все.
- Пробел, оставленный сознательно: `profi.client_typing` и `profi.client_read` разбираются службой только после калибровки (дизайн 5.17, пункт 2); ядро их уже принимает (C1) и работает без них.
