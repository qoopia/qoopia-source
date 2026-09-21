# Фаза 2 — AS-IS audit прод-Qoopia

> Historical document retained for archaeology. It is not an operational source of truth and its
> commands must not be run against the current schema. Current state: `python3 scripts/project-status.py --live`;
> current operations: `docs/operations/`; production compose: `deploy/docker-compose.release.yml`.

**Начата**: 2026-04-11
**Источник**: `~/.openclaw/qoopia/` (read-only для этой фазы)
**Призма**: принципы Фазы 1 + Simplicity Pass (ADR-001 до ADR-006)

## Цель фазы

Разобрать **что реально есть** в текущей V2 — схема БД, MCP tools, CRUD пути, core-сервисы, auth, deployment — и для каждой подсистемы вынести вердикт: **keep / simplify / drop** в V3.0.

Это **не аудит на баги**. Это аудит на **соответствие V3.0 принципам**.

## Правила фазы

1. **Ничего не менять в проде**. Все файлы `~/.openclaw/qoopia/` — read-only. Никаких `git commit`, `npm install`, миграций, API-вызовов на живой сервер.
2. **Каждая находка** получает тег: **KEEP** (переносим как есть) / **SIMPLIFY** (упрощаем под V3.0) / **DROP** (не несём в V3.0 / отложено в V3.5+).
3. **Ссылки на файлы** — абсолютные пути в формате `~/.openclaw/qoopia/src/foo.ts:123`.
4. **LoC** — для каждой существенной подсистемы указывается реальный размер, чтобы сравнивать с бюджетами группы H.
5. **Baseline сравнения** — `research/peers/lcm-mcp/` Нияза (665 LoC) для session memory и minimal MCP server.

## Deliverables

| Документ | Что внутри |
|---|---|
| `00-overview.md` | High-level картина V2: стек, размер, структура, ключевые находки |
| `01-schema.md` | Аудит 20 реальных таблиц + FTS5, keep/simplify/drop per table |
| `02-mcp-tools.md` | Аудит 9 MCP tools (note/recall/brief + CRUD), tool_profiles, permission model |
| `03-core-services.md` | intelligence.ts (657 LoC), keywords, retention, activity-log, event-bus, webhooks |
| `04-auth.md` | OAuth + magic-links + users/agents как identity слой |
| `05-api-rest.md` | REST handlers (что из них для dashboard, что для MCP, что вообще не надо) |
| `06-deployment.md` | start.sh, launchd (через OpenClaw cron), миграции, логи, бэкапы |
| `07-migration-map.md` | Итоговая таблица: каждая подсистема → куда в V3.0 |

## Что НЕ в scope

- Переписывание кода (Фаза 5)
- Проектирование V3.0 архитектуры (Фаза 3)
- Фиксы багов в V2 (это **не** рефакторинг V2, это audit для V3)
- Создание тест-кейсов

## Primary acceptance test для Фазы 2

После завершения — у Асхата должен быть **один документ** (`07-migration-map.md`), в котором по каждой подсистеме V2 написано:
- Что это
- Насколько большое (LoC / tables / endpoints)
- В V3.0 оно **есть / упрощается / выкинуто**
- Если остаётся — **какой путь миграции**

Этот документ станет входом в Фазу 3 (TO-BE). Без него Фаза 3 работает вслепую.
