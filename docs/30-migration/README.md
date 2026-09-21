# Фаза 4 — Migration planning (V2 → V3.0)

> Historical document retained for archaeology. It is not an operational source of truth and its
> commands must not be run against the current schema. Current state: `python3 scripts/project-status.py --live`;
> current operations: `docs/operations/`; production compose: `deploy/docker-compose.release.yml`.

**Начата**: 2026-04-11
**Базис**: Phase 2 07-migration-map.md (per-subsystem decisions) + Phase 3 20-to-be (target architecture)

## Цель фазы

Phase 2 уже определила **что** переносится / упрощается / выкидывается. Phase 3 определила **как выглядит target**. Phase 4 отвечает на: **как именно мы туда попадём** — executable план миграции.

## Отличие от Phase 2 / Phase 3

- Phase 2 **audit** = «что есть в V2»
- Phase 3 **design** = «как будет выглядеть V3»
- **Phase 4 migration** = «как перейти от A к B без потерь и с возможностью отката»

## Deliverables

| Документ | Что внутри |
|---|---|
| `00-overview.md` | High-level migration strategy + timeline (этот файл входит сюда) |
| `01-data-migration.md` | Executable row-by-row transformation spec: для каждой V2 таблицы — exact mapping в V3 схему. Формат: SQL или TypeScript pseudo-code готовый к реализации. |
| `02-cutover.md` | Parallel V2+V3 runtime план, порядок переключения агентов (Alan → Aizek → Claude → Dan → Aidan), Saule pre-flight checklist, rollback plan |
| ADR-011 | Phase 4 accepted, ready for Phase 5 Execute |

## Правила фазы

1. **Prod V2 остаётся нетронутой** на всём протяжении миграции (read-only). Это единственный безопасный rollback path.
2. **V3 DB создаётся параллельно** в `~/.qoopia/data/qoopia.db`, V2 живёт в `~/.openclaw/qoopia/data/qoopia.db`.
3. **Agents migrated ONE AT A TIME** — не big-bang. Rollback одного агента не блокирует остальных.
4. **Aidan мигрируется последним** — он пишет реальным людям, failures тут имеют внешние последствия.
5. **Каждый агент проходит тест через живое использование ≥ 3 дня** на V3 прежде чем считать его migrated.
6. **V2 выключается только после того как все агенты стабильно на V3 ≥ 1 неделя**.

## Scope Phase 4

- ✅ Data migration script spec
- ✅ Cutover strategy
- ✅ Rollback plan
- ✅ Saule deployment gate
- ❌ Implementation кода V3.0 (это Phase 5)
- ❌ Миграция агентских system prompts (это admin task, не Qoopia migration)
- ❌ Migration у сторонних пользователей кроме Сауле (нет таких сейчас)

## Primary acceptance test Phase 4

После этой фазы у developer (или будущего Claude) должен быть **runbook**, по которому миграция проводится:

1. Запуск transformation script (01-data-migration.md)
2. Запуск V3 server параллельно с V2
3. Переключение агентов по одному (02-cutover.md)
4. Monitoring метрик успеха на каждом шаге
5. Rollback если что-то идёт не так (02-cutover.md)
6. Выключение V2 после confirmation

**Без** этого runbook миграция была бы ad-hoc и рискованной.
