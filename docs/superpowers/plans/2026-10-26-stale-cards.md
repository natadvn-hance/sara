# Карточка закрытой заявки: план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Карточка, которая ждёт решения Бориса, перестаёт быть нажимаемой, когда её заявка закрылась на Профи.ру: кнопки снимаются, добавляется строка «Заявка закрыта на Профи.ру, откликнуться уже нельзя».

**Architecture:** Узел считает закрытым и «пустой» ответ страницы заказа (нет формы, bidForms, тарифа и цены, нет нашего отклика). Ядро раз в 10 минут, с 9:00 до 23:00 по Москве, перечитывает `get_order` у ждущих карточек старше часа (дальше раз в час), не больше 4 страниц за проход. Если в проходе большинство проверенных выглядит закрытыми, Борису уходит предупреждение, и ничего не закрывается. Закрытая заявка: задача закрывается, все сообщения её карточки (с напоминаниями) правятся, в журнал пишется `lead.closed_on_site`. То же после нажатия, которое кончилось `ORDER_CLOSED`.

**Tech Stack:** TypeScript, DBOS, Drizzle (без миграции), grammY, vitest, подставные Профи.ру, Профи-MCP и Telegram.

**Spec:** сообщение главной сессии от 25.10.2026 (живой случай: заказ 95385373, карточка 10:03, закрыт клиентом, нажатие 16:19 дало ORDER_CLOSED); `docs/superpowers/specs/2026-10-24-m2-one-tap-design.md`.

## Global Constraints

- Тексты Борису по-русски, просто, без длинного тире (U+2014).
- Без миграции: номера сообщений карточки берутся из `task.telegram_message_id` и из журнала `card.sent` (поле `message_id`), время последней проверки из `lead.page_read`.
- Узел: вкладка общая с доской, `get_order` уже идёт через `inTab`. Ядро прекращает проход на первой непрочитанной странице (вкладка занята, сессия, связь).
- Локально только затронутые тесты и `pnpm check`; полный набор гоняет CI.
- Имена тестов начинаются с номера требования: FR-LEAD-5.

## Review Focus

1. Закрытие без нажатия Бориса никогда не трогает задачу, которую он уже решил (нажал, пропустил): закрывается только `state = 'open'`. Тест в Task 4.
2. Сломанная правка сообщения в Telegram (сообщение удалено, «not modified») не останавливает закрытие остальных. Тест в Task 3.
3. Ночью (23:00-9:00 по Москве) ни одной страницы. Тест в Task 4.
4. Большинство закрытых в одном проходе: ни одна карточка не закрыта, одно предупреждение в сутки. Тест в Task 4.
5. Ответ узла из памяти (`from_page` не true) не считается прочтением. Тест в Task 4.

---

### Task 1: Узел, «пустой» ответ это закрытый заказ

**Files:** `apps/profi-node/src/bid/screen.ts`, `apps/profi-node/src/bid/bidTools.ts` (getOrder), `tests/fakes/profiSite/server.ts` (настройка заказа `bare`), тесты `apps/profi-node/test/bidScreen.test.ts`, `apps/profi-node/test/bidTools.test.ts`.

- [ ] `OrderScreen.bare: boolean`: нет `form`, нет непустых `bidForms`, нет `tariffsBlock`, нет `price`, и `hasBid !== true`. Ответ «форма без тарифа» не bare.
- [ ] getOrder: `closed = screen ? screen.disabled || screen.bare : closedNotice(page)`.
- [ ] Тесты: образец без form/bidForms/tariffsBlock/price даёт `bare: true, open: false`; с `hasBid: true` не bare; без tariffsBlock, но с формой, не bare; get_order такого заказа на подставном сайте даёт `open: false, from_page: true`.

### Task 2: Номера всех сообщений карточки в журнале

**Files:** `apps/core/src/leads/pipeline.ts`.

- [ ] `cardSent(..., via)` пишет в `card.sent` ещё `message_id`. `onReminder` и `resendCard` тоже зовут `cardSent` (`via: 'reminder' | 'resend'`). Отчёт скорости читает только `via = 'order'`, дневной лимит считает задачи: оба не меняются.

### Task 3: Правка карточки закрытой заявки

**Files:** `apps/core/src/notify/notifier.ts`, `apps/core/src/notify/telegram.ts`, `apps/core/src/notify/cards.ts` (текст и вёрстка), `apps/core/src/leads/pipeline.ts` (`closeOnSite`), `apps/core/src/leads/outbox.ts` (после `ORDER_CLOSED`), `packages/shared/src/contracts/eventTypes.ts` (`lead.closed_on_site`, `lead.recheck_doubt`), `tests/fakes/telegramApi.ts` (запись `editMessageText`), подставные уведомители в тестах.

- [ ] `Notifier.closeLeadCard(messageId, card)`: `editMessageText` с HTML карточки и строкой `TEXTS.closedOnSite` внизу, `reply_markup: { inline_keyboard: [] }`. Строка входит в лимит 4096 (вёрстка `renderLeadCard` учитывает её). Ошибка Telegram ловится и пишется в лог.
- [ ] `pipeline.closeOnSite(taskId, via: 'recheck' | 'press')`: в транзакции задача `open` закрывается (`resolved`, `skip`, `task.resolved` с причиной `closed`), заявка получает статус `closed`, пишется `lead.closed_on_site { via }`; затем `deliverDecision(taskId, 'skip')`, если задача закрылась здесь; затем правка каждого сообщения карточки (уникальные `message_id` из `card.sent` задачи и `task.telegram_message_id`).
- [ ] outbox: в ветке `ORDER_CLOSED` функции `backToBoris` шаг `closeCard(taskId)` (зависимость как `resendCard`).

### Task 4: Перепроверка ждущих карточек

**Files:** новый `apps/core/src/leads/recheck.ts`, `apps/core/src/app.ts` (запуск и остановка, `recheckTickMs`), тесты `tests/e2e/recheck.test.ts`.

- [ ] `startCardRecheck({ db, profi, notifier, close, now?, tickMs?, perPass? })` → `{ stop(), tick(): Promise<{ checked; closed; doubt }> }`, тик раз в 10 минут, по одному.
- [ ] Проход: только час по Москве в `[9, 23)`. Кандидаты: задачи `lead_decision` в `open`, у которых последний взгляд (позднее из первого `card.sent` задачи и последнего `lead.page_read` заявки) старше часа, старшие первыми, не больше `perPass = 4`.
- [ ] Каждая: `getOrder`; ошибка или `from_page !== true` пишет `lead.page_read { ok: false, error, via: 'recheck' }` и прекращает проход. Прочитанная пишет `lead.page_read { ok: true, open, has_bid, fee_rub, client_info, error: null, via: 'recheck' }`; закрыта, если `open === false` и `has_bid !== true`.
- [ ] Защита: проверено не меньше 3 и закрытых больше половины: ни одной не закрывать, Борису `TEXTS.recheckDoubt(closed, checked)` не чаще раза в сутки (`lead.recheck_doubt` в журнале). Иначе `close(taskId)` для каждой закрытой.
- [ ] Тесты e2e (подставные профи и Telegram, `now` подставляется: первое время не раньше чем через 61 минуту, в часы 9-23 по Москве):
  - открытая заявка: страница прочитана, карточка не тронута; раньше часа не читается;
  - закрытая: правка карточки и копии-напоминания (кнопок нет, строка есть), задача закрыта, `lead.closed_on_site`;
  - ночь: ни одного чтения;
  - 3 закрытых из 3: предупреждение, ни одной правки, задачи открыты; второй проход в те же сутки без второго предупреждения;
  - ответ из памяти: не закрывает, проход прекращён;
  - нажатие «Откликнуться», которое кончилось `ORDER_CLOSED`: карточка правится.
