# Сара Hance

ИИ-сотрудник продаж агентства Hance на Профи.ру: замечает подходящие
заявки, откликается по решению Бориса, разговаривает с клиентами его
голосом и доводит до созвона.

**Состояние:** документы к разработке готовы, кода пока нет. Первая веха
M0 (фундамент и сквозной путь) стартует после утверждения пакета.

## Документы

Карта всех документов: [docs/README.md](docs/README.md).

Главные:
- [Видение и границы](docs/product/vision-and-scope.md)
- [Спецификация](docs/spec/2026-10-22-sara-spec-v1.md)
- [Дорожная карта](docs/product/roadmap.md)
- [Порядок старта разработки](docs/product/start-sequence.md)

## Как устроен репозиторий

```
apps/core        ядро и бот
apps/web         пульт и Mini App
apps/profi-node  Профи-MCP и браузеры аккаунтов
packages/shared  контракты и общие типы
roles/           роли Claude: инструкции и схемы ответов
infra/           Docker Compose, выкладка, бэкапы
docs/            документы
tests/           фальшивый Профи.ру, образцы, экзамен
```

## Быстрый старт

Нужны Node 24, pnpm (через `corepack enable`) и Docker (OrbStack или
Docker Desktop).

```bash
pnpm install
pnpm dev
```

Пульт откроется на http://localhost:5173, ядро на порту 3300, фальшивый
Профи.ру на 7070. Мастер запуска проведёт через пароль, бота и Claude.

| Команда | Что делает |
|---|---|
| `pnpm fake:order` | фальшивая заявка уходит в ядро |
| `pnpm bids:on`, `pnpm bids:off` | включить или выключить отправку откликов (по умолчанию выключена) |
| `pnpm test` | все тесты (база в Docker должна быть запущена) |
| `pnpm --filter @sara/web e2e` | проверка пульта в браузере |
| `pnpm check` | форматирование, линтер, типы, длинное тире |
| `pnpm trace` | отчёт «требование → история → тест» |
| `pnpm report:speed` | время «заявка → карточка» и «да → отклик» |
| `pnpm probe:claude` | один пробный вызов Claude |
| `pnpm role:eval sorter` | Сортировщик на 10 образцах, настоящий Claude |
| `pnpm smoke:claude-container` | Claude внутри контейнера ядра |
| `pnpm mind:check <папка>` | проверка записей разума |

## Участие в разработке

[CONTRIBUTING.md](CONTRIBUTING.md) и правила для сессий Claude Code в
[CLAUDE.md](CLAUDE.md).
