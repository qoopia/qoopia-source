# Фаза 3 — TO-BE: целевая архитектура V3.0

> Historical document retained for archaeology. It is not an operational source of truth and its
> commands must not be run against the current schema. Current state: `python3 scripts/project-status.py --live`;
> current operations: `docs/operations/`; production compose: `deploy/docker-compose.release.yml`.

**Начата**: 2026-04-11
**Базис**: Phase 1 principles + Phase 1.5 Simplicity Pass + Phase 2 AS-IS audit

## Цель фазы

Спроектировать **конкретную, исполнимую** архитектуру Qoopia V3.0:
- DDL схема (SQL, готовая к применению)
- MCP tool specifications (JSON schemas, готовые к copy в код)
- Runtime / transport / auth решения (с ADR)
- Deployment pipeline (qoopia install, launchd, env vars)
- System prompt template для агентов (≤ 30 строк как H7)

Это **не реализация** (Фаза 5 Execute). Это **blueprint**, с которого будет писаться код.

## Правила фазы

1. **Никакой реализации** — не пишем TypeScript/Bun код V3.0 в этой фазе. Только design docs.
2. **Каждое архитектурное решение** с ≥3 альтернативами → ADR (правило из ADR-000 template).
3. **Все критерии Phase 1** должны быть покрыты конкретным design decision. Если что-то не покрыто — это gap который фиксируется явно.
4. **Все number-budgets группы H** должны быть достижимы по дизайну (не надеждой).
5. **Baseline** для сравнения — lcm-mcp Нияза (665 LoC) + V2 реальность (9379 LoC).

## Deliverables

| Документ | Что внутри |
|---|---|
| `00-overview.md` | Архитектурная диаграмма + summary слоёв |
| `01-schema.md` | Полная DDL: CREATE TABLE statements, indexes, FTS5 triggers, constraints |
| `02-mcp-tools.md` | Каждый MCP tool с JSON schema + behavior + examples |
| `03-system-prompt.md` | Template ≤ 30 строк для любого агента + mapping на use cases |
| `04-install.md` | `qoopia install` flow + launchd plist template + env vars |
| ADR-007 | Runtime: Bun vs Node decision |
| ADR-008 | Transport: MCP SDK vs custom JSON-RPC |
| ADR-009 | Auth: opaque tokens vs JWT |
| ADR-010 | Phase 3 accepted, ready for Phase 5 |

## Что НЕ в scope Фазы 3

- Написание кода (Фаза 5)
- Миграция данных (Фаза 4)
- UI компоненты dashboard (отложено в V3.5)
- Layer B semantic (отложено в V3.5)
- Что-либо не покрытое принципами Phase 1

## Primary acceptance test Фазы 3

После завершения — **разработчик (или будущая Claude сессия) может начать писать код V3.0** без дополнительных design-вопросов. Всё решено. Все DDL готовы к применению. Все MCP tools готовы к implementation. Все bootstrap решения (runtime, transport, auth) зафиксированы в ADR.

Если в Фазе 5 придётся принимать архитектурное решение — это **провал** Фазы 3 и триггер ревью документов TO-BE.
