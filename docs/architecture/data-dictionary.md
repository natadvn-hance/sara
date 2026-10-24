# Словарь данных

| | |
|---|---|
| Версия | 1.0, 22.10.2026 |
| Связано | спецификация 7.1 и 8; контракты C1, C7; модель угроз, раздел «Данные» |
| Правила | время только UTC (`timestamptz`); деньги целым числом в рублях; переход этапа только функцией `transition`; каждое изменение порождает событие C1 |

## 1. Классы данных

| Класс | Что | Пример | Где первая запись | Обращение |
|---|---|---|---|---|
| **Н** | не персональные | балл, цена отклика, настройки | ядро | без ограничений |
| **П** | персональные данные клиента | имя, текст заказа, переписка | схема `node` на сервере | минимум, обезличивание перед моделью (ADR-016), сроки хранения |
| **К** | контакт клиента | телефон, почта, мессенджер | схема `core` на сервере | только для встречи, удаление через 30 дней после неё |
| **С** | секрет | сессия Профи.ру, токены | там, где используется | зашифровано (sops и age), права 600, не в базе в открытом виде |

## 2. Схема `node`: сырые данные площадки

Пишет только служба Профи-MCP. Отдельная схема нужна, чтобы её можно
было перенести в управляемую базу в России, если этого потребует юрист
(ADR-022).

| Таблица | Поля | Класс | Срок |
|---|---|---|---|
| `raw_event` | `id`, `account_id`, `kind` (`rtp`, `response`, `dom`), `received_at`, `body` (jsonb), `shipped_at` | П | 30 дней, затем удаление (в ядре остаются разобранные данные) |
| `raw_order` | `order_id`, `account_id`, `seen_at`, `body` | П | 30 дней |
| `raw_message` | `platform_message_id`, `chat_id`, `account_id`, `author_side` (`client`, `specialist`), `sent_at`, `text` | П | 2 года для закрытых, как в ядре |
| `outbox_node` | `event_id`, `payload`, `attempts`, `next_try_at`, `confirmed_at` | П | до подтверждения + 7 дней |
| `browser_profile` | папка профиля на диске, вне базы | С | пока аккаунт активен |

## 3. Схема `core`: рабочая база ядра

### 3.1 Аккаунты и направления

| Таблица | Поле | Тип | Класс | Смысл |
|---|---|---|---|---|
| `account` | `id` | text | Н | короткое имя, например `hance-marketing` |
| | `title` | text | Н | название в пульте |
| | `profi_profile_id` | text | Н | номер анкеты на площадке |
| | `login_state` | enum `alive`, `dead`, `banned`, `unknown` | Н | состояние входа |
| | `presence` | bool | Н | присутствие включено |
| | `egress_ip` | inet | Н | IP аккаунта на сервере |
| | `balance_rub` | int | Н | баланс кошелька, последний замер |
| | `balance_at` | timestamptz | Н | когда замерен |
| | `paused` | bool | Н | пауза аккаунта |
| `direction` | `id`, `account_id`, `title`, `description`, `stop_factors` (jsonb), `scoring_version_id`, `bid_format` (jsonb), `speed_mode` (`normal`, `fast`), `daily_budget_rub`, `max_bid_rub`, `auto_bid_rule` (jsonb, по умолчанию выключено) | | Н | направление аккаунта |
| `scoring_version` | `id`, `direction_id`, `version`, `gates` (jsonb), `criteria` (jsonb: критерий, вес, как мерить), `threshold`, `calibration_agreement` (numeric), `created_at`, `approved_by_boris_at` | | Н | система оценки с версиями |
| `calibration` | `id`, `scoring_version_id`, `lead_id`, `boris_fit` (bool), `model_fit` (bool), `model_score`, `note` | | Н | отметки калибровки |
| `case` | `id`, `direction_id`, `url`, `title`, `tags` (text[]), `show_rule` | | Н | кейсы для откликов |

### 3.2 Заявки и клиенты

| Таблица | Поле | Тип | Класс | Смысл |
|---|---|---|---|---|
| `lead` | `id` | text | Н | номер заказа Профи.ру |
| | `account_id` | text | Н | каким аккаунтом замечен первым |
| | `title`, `category`, `city` | text | Н | тема, категория, город |
| | `text` | text | П | описание заказа |
| | `client_name` | text | П | имя клиента, как на площадке |
| | `budget_text` | text | Н | бюджет словами |
| | `bid_price_rub` | int | Н | цена отклика |
| | `place` | int | Н | место отклика, если известно |
| | `is_open` | bool | Н | заказ открыт |
| | `seen_at` | timestamptz | Н | когда замечен |
| | `routed_direction_id` | text | Н | выбранное направление |
| | `status` | enum `new`, `sorted_out`, `queued`, `decided`, `bid_sent`, `skipped`, `expired` | Н | судьба заявки |
| | `draft_text` | text | П | текст отклика с приветствием: черновик Аналитика или правка Бориса; null, пока черновика нет (FR-LEAD-6) |
| | `draft_price_rub` | int | Н | «Стоимость услуги» в отклике; null: поле остаётся пустым |
| | `draft_analysis` | jsonb | П | разбор Аналитика: шаги чтения заказа (`reading`: явное, неявные слои, чего хочет, кто это, риски, работа для нас) и короткий итог (`hidden_need`, `risk`, `condition`); null: разбора нет |
| `lead_score` | `lead_id`, `direction_id`, `scoring_version_id`, `gates_passed` (bool), `score` (0-100), `reasons` (jsonb), `confidence`, `model_call_id` | | Н | оценка заявки направлением |
| `deal` | `id` | uuid | Н | клиент после отклика |
| | `lead_id`, `account_id`, `direction_id` | | Н | связи |
| | `chat_id` | text | Н | номер чата на площадке |
| | `stage` | enum (спецификация 7.2) | Н | этап |
| | `owner` | enum `sara`, `boris`, `paused` | Н | кто ведёт |
| | `turn` | enum `client`, `sara`, `boris`, `nobody` | Н | чей ход |
| | `boris_note` | text | Н | указание Бориса при возврате Саре |
| | `amount_rub`, `outcome`, `outcome_reason` | | Н | итог |
| `message` | `id` | uuid | Н | |
| | `deal_id` | uuid | Н | |
| | `platform_message_id` | text | Н | номер на площадке (уникален) |
| | `author` | enum `client`, `boris`, `sara`, `sara_v1`, `unknown` | Н | автор |
| | `text` | text | П | текст |
| | `sent_at`, `read_at` | timestamptz | Н | время, прочитано |
| | `delivery` | enum `received`, `queued`, `sent`, `confirmed`, `failed` | Н | доставка |
| | `mind_version` | text | Н | версия разума, на которой написан ответ Сары |
| | `fact_ids` | text[] | Н | номера записей разума, на которые опирается |
| `client_contact` | `deal_id`, `kind` (`phone`, `email`, `messenger`), `value`, `delete_after` | | К | контакт для встречи |

### 3.3 Работа и надёжность

| Таблица | Поля | Класс | Смысл |
|---|---|---|---|
| `event` | конверт C1 | Н, в `payload` бывает П | журнал, только добавление; ссылки на П по номерам, а не копией текста |
| `task` | `id`, `kind`, `entity_kind`, `entity_id`, `priority`, `due_at`, `state` (`open`, `resolved`, `expired`), `resolution`, `telegram_message_id` | Н | что ждёт Бориса |
| `outbox` | `id`, `kind` (`bid`, `message`), `idempotency_key` (уникален), `payload`, `permit`, `attempts`, `state`, `confirmed_at`, `error_class` | П | действия наружу |
| `commitment` | `id`, `deal_id`, `what`, `due_at`, `workflow_id`, `state` | Н | обещания с таймером |
| `meeting` | `id`, `deal_id`, `starts_at`, `duration_min`, `channel`, `brief`, `outcome`, `amount_rub` | Н | встречи |
| `availability` | `id`, `weekday`, `from_time`, `to_time`, `slot_min`, `max_per_day`, `exceptions` (jsonb) | Н | свободное время Бориса |
| `spend` | `id`, `lead_id`, `account_id`, `amount_rub`, `balance_before`, `balance_after`, `at`, `outbox_id` | Н | траты |
| `model_call` | `id`, `role`, `role_version`, `model`, `priority`, `started_at`, `duration_ms`, `ok`, `error_class`, `est_tokens_in`, `est_tokens_out`, `pseudonymized` (bool) | Н | вызовы Claude, без текста |
| `setting`, `setting_history` | `key`, `value` (jsonb), `changed_by`, `changed_at` | Н | настройки C7 |
| `owner_auth` | `password_hash`, `telegram_user_id`, `telegram_chat_id`, `updated_at` | С | вход владельца |

### 3.4 Разум и учёба

| Таблица | Поля | Класс | Смысл |
|---|---|---|---|
| `mind_index` | `record_id`, `path`, `type`, `scope`, `status`, `version`, `tsv` (полнотекстовый по-русски), `embedding` (vector 384) | Н (обезличено) | индекс файлов разума |
| `lesson` | `id`, `source` (`edit`, `training`, `interview`), `source_ref`, `before`, `after`, `insight`, `decision` (`yes`, `no`, `skip`), `decided_at`, `mind_commit` | Н (обезличено) | уроки |
| `persona`, `scenario` | `id`, `archetype`, `description`, `source_refs` | Н (обезличено) | материалы тренажёра |
| `training_session` | `id`, `mode`, `scenario_id`, `started_at`, `finished_at`, `similarity`, `lessons_count` | Н | тренировки |
| `autonomy` | `topic`, `direction_id`, `level` (`self`, `draft`, `call`), `approvals_in_row`, `last_change_at` | Н | самостоятельность |
| `exam_run`, `exam_result` | `id`, `mind_version`, `roles_version`, `started_at`, `score`; по сценарию: оценка, класс ошибки, тяжесть | Н | экзамены |
| `sim_dialog` | `id`, `persona_id`, `created_at`, `found_gap` | Н | сгенерированные диалоги, никогда не знание |

## 4. Сроки хранения и удаление

| Данные | Срок | Как |
|---|---|---|
| Переписка закрытых клиентов (`message.text`, `lead.text`, `client_name`) | 2 года после закрытия | ночная задача очищает текст, оставляя цифры для аналитики |
| Контакты (`client_contact`) | 30 дней после встречи | ночная задача |
| Сырые данные площадки (`node.raw_*`) | 30 дней | ночная задача |
| Удаление по просьбе клиента | сразу | одна команда из пульта: схемы `node` и `core`, событие `privacy.erased` без данных |
| Бэкапы | 30 дней | удалённое из базы исчезает из бэкапов за 30 дней |

## 5. Схема связей

```mermaid
erDiagram
  account ||--|| direction : "направление"
  direction ||--o{ scoring_version : "версии оценки"
  direction ||--o{ case : "кейсы"
  account ||--o{ lead : "замечает"
  lead ||--o{ lead_score : "оценки"
  lead ||--o| deal : "после отклика"
  deal ||--o{ message : "переписка"
  deal ||--o{ meeting : "встречи"
  deal ||--o{ commitment : "обещания"
  deal ||--o| client_contact : "контакт"
  lead ||--o{ spend : "траты"
  task }o--|| deal : "о ком"
  outbox ||--o| spend : "оплатило"
  lesson }o--o| mind_index : "изменило"
  training_session }o--|| scenario : "по сценарию"
  scenario }o--|| persona : "персона"
  exam_run ||--o{ exam_result : "итоги"
```
