# Технологический радар

| | |
|---|---|
| Версия | 1.0, 22.10.2026 |
| Метод | радар ThoughtWorks: Берём, Пробуем, Изучаем, Не берём |
| Правило | новая библиотека или сервис только из колонки «Берём» или «Пробуем»; всё остальное через ADR. Версии закрепляются в `package.json` и образах |

## Берём

| Что | Зачем |
|---|---|
| TypeScript (строгий режим), Node 24 LTS | один язык во всех частях (ADR-011) |
| pnpm workspaces | монорепозиторий без лишних инструментов |
| Fastify 5 + `fastify-type-provider-zod` + `@fastify/swagger` | API пульта, OpenAPI из схем (ADR-014) |
| zod | контракты в коде (ADR-014) |
| Postgres 16 + pgvector | база: схемы `core` и `node`, векторы разума (ADR-006) |
| Drizzle ORM + drizzle-kit | схема и миграции в TypeScript (ADR-020) |
| grammY | бот Telegram |
| React 19 + Vite, TanStack Query | пульт и Mini App из одного кода |
| Tailwind CSS + shadcn/ui + Lucide | дизайн-система |
| Playwright (Chromium) | живые вкладки Профи-MCP и тесты пульта |
| MCP TypeScript SDK | Профи-MCP |
| Vitest | тесты |
| Biome | форматирование и линтер одним инструментом |
| pino | журнал работы процессов |
| Docker Compose | запуск на Маке и на сервере |
| GitHub Actions, GHCR | CI и образы |
| sops + age | секреты |
| Claude Code CLI (закреплённая версия) | модель по подписке (ADR-001) |
| Conventional Commits + release-please | версии и список изменений (ADR-018) |
| gitleaks | поиск секретов в CI |

## Пробуем

| Что | Где проверяем | Если не подойдёт |
|---|---|---|
| DBOS Transact | M0, история ST-M0-05 | pg-boss на той же базе |
| transformers.js + `multilingual-e5-small` | M4, поиск по разуму | только полнотекстовый поиск |
| `@telegram-apps/sdk-react` | M7, Mini App | прямой `window.Telegram.WebApp` |
| TanStack Router | M7, пульт | React Router |
| GlitchTip (облачный бесплатный план) | M2 | Sentry бесплатный план |
| wal-g | M1, бэкапы | pgBackRest |
| microsocks (SOCKS на отдельный IP) | M1, IP аккаунта | 3proxy |

## Изучаем

| Что | Когда вернёмся |
|---|---|
| Метод GEPA (улучшение инструкций по провалам) | M5, когда накопятся провалы экзамена |
| Оценка ответов моделью-судьёй | M4: доверяем только после сверки с оценками Бориса от 80% |
| Grafana для метрик | если метрик из журнала станет мало |
| Postgres 17 | при следующем крупном обновлении |

## Не берём

| Что | Почему |
|---|---|
| API Claude по ключу | решение Бориса (ADR-001); остаётся запасным путём шлюза |
| Jev | решение Бориса 21.10 |
| Дообучение модели | ADR-008 |
| Google Calendar | ADR-012 |
| SQLite для ядра | одна запись за раз, урок v1 (ADR-006) |
| Прямые запросы к Профи.ру и закрытый API приложения | риск аккаунта (ADR-002) |
| Puppeteer | Playwright уже берём |
| LangChain и похожие обёртки | лишний слой над `claude -p` |
| Next.js | серверная отрисовка не нужна |
| Redis, Kafka, Kubernetes | Postgres и Docker Compose хватает на одного пользователя |
| WireGuard и второй узел | один сервер (ADR-021) |
