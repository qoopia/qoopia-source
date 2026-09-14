# Operational normalization contract

Status: Phase 4 / WS-9 review artifact, 2026-07-16. No production action has
been performed by this change.

## One trusted runtime path

The supported production path is the immutable release image started by
`deploy/docker-compose.release.yml`. Source bind mounts, mutable image tags,
automatic startup migration, and per-container aliases such as
`/host/srv/qoopia` are not supported release inputs.

`QOOPIA_ROOT` is the only root-path coordinate. It must be absolute and visible
at the same path on the host and in the container. For the current Corsair
deployment the intended value is `/srv/qoopia`.

| Purpose | Canonical path |
|---|---|
| Runtime database | `$QOOPIA_ROOT/data/qoopia.db` |
| Logs | `$QOOPIA_ROOT/logs` |
| Backups | `$QOOPIA_ROOT/backups` |
| Runtime secret environment | `$QOOPIA_ROOT/.env` |
| Reviewed application code | immutable image `/app` |
| Release stamp | `/app/release.json` |

Production validation rejects path overrides that do not resolve to those
three root children. Development and tests retain local defaults.

## Release inputs and preflight

The non-secret operator inputs are modeled by
`deploy/release-operator.env.example`:

- `QOOPIA_IMAGE_REF`: `name@sha256:<64 hex>` or local `sha256:<64 hex>`;
- `QOOPIA_RELEASE_SHA`: reviewed full git SHA;
- `QOOPIA_ROOT`: canonical absolute root;
- `QOOPIA_SERVER_ROLE`: `canonical` or `legacy-readonly`;
- `QOOPIA_PORT`: explicit service/health-check port;
- `QOOPIA_AUTO_MIGRATE=false`.

Before an owner-approved rollout, load only that non-secret operator file and
run:

```bash
bun run ops:validate-release-inputs
docker compose --env-file /approved/path/release-operator.env \
  -f deploy/docker-compose.release.yml config
```

The rendered compose must show the immutable image reference, reviewed SHA,
exact role, `QOOPIA_AUTO_MIGRATE=false`, and identical host/container root
paths. The service secret file is separate at `$QOOPIA_ROOT/.env`; validators
must never print its values.

`bun run release:build` prints an immutable local image ID in `image_ref`. A
registry rollout must use the registry-provided digest after push, never the
human-readable tag.

## Startup and schema sequencing

Normal service startup performs only migration discovery. If any migration is
pending, startup exits non-zero even when a stale environment still contains
`QOOPIA_AUTO_MIGRATE=true`; production config validation rejects that value as
well.

The schema sequence is a separate one-shot operation:

1. Obtain explicit owner GO and record the reviewed release SHA.
2. Quiesce writers and take the required fresh operational backup.
3. Run `bun run db:integrity` against the intended database or approved
   snapshot.
4. Resolve any integrity failure under its own reviewed repair plan.
5. Run `bun run migrate`. The command repeats the integrity preflight, writes a
   mode-0600 `VACUUM INTO` backup, then applies pending migrations.
6. Re-run integrity and record applied versions before starting the service.

The known 13 historical AgentComm foreign-key violations are an intentional
ordering dependency. The prepared-only repair plan is
`docs/runbooks/phase3-existing-fk-repair-plan.md`. Until an owner-approved
repair produces a clean preflight, migration/import/verification and
shadow-sync apply are expected to refuse production. Do not weaken the guard to
make a rollout appear green.

## Phase 3 operational semantics

AgentComm inbox state is authoritative; webhooks are optional acceleration.
Webhook delivery is at-least-once because a process can exit after the remote
accepts a POST but before the local outcome commits. Delivery is bounded by the
attempt ceiling and stale-event retirement. Terminal wake records are retained
for the configured window, then pruned by maintenance; retryable rows are not
pruned.

OAuth cleanup and historical FK repair remain prepared-only runbooks. No
production client deletion, token rotation, row repair, or backfill belongs in
normal startup.

## Fleet instruction and tool contract

Agent instruction files use provider-neutral real paths. The fleet rollout
removes the literal `CLAUDE/GEMINI/` segment rather than creating aliases for a
broken template:

- `AGENTS.md` for the current directory;
- `tools/AGENTS.md`;
- `tools/<tool-family>/AGENTS.md`;
- `memory_system/AGENTS.md`, `skills/AGENTS.md`, and
  `cron_tasks/AGENTS.md`;
- `../config/AGENTS.md` for the sibling Ductor configuration instructions.

The placeholder `CLAUDE/GEMINI/AGENTS.md` in any of those paths is invalid.
Validate a fleet workspace with:

```bash
bun run ops:validate-agent-paths -- --workspace /absolute/agent/workspace
```

Core tool parity uses `deploy/fleet-tools-contract.json`. A fleet rollout must
publish one immutable canonical tool bundle, write the declared release string
to `tools/.qoopia-tool-release`, and then either mount that bundle directly or
copy it byte-for-byte. Local customization belongs under excluded `tools/local/`
overlays. Validate behavior parity by supplying the canonical bundle:

```bash
bun run ops:validate-agent-paths -- \
  --canonical-tools /absolute/canonical/tools \
  --workspace /absolute/agent-one/workspace \
  --workspace /absolute/agent-two/workspace
```

The validator fails on unresolved instruction paths, missing required tool
families, version-marker mismatch, or byte drift outside declared overlays.
Updating live agent workspaces and distributing the canonical bundle are
outside this repository and require an explicit owner-approved fleet rollout.

## Owner-GO items outside repository scope

- repair or quarantine the 13 historical FK violations;
- run migrations and restart/deploy the reviewed image;
- replace live root aliases/mutable compose inputs;
- distribute the canonical fleet tool bundle and fix active workspace
  instruction files;
- clean duplicate OAuth clients or legacy NULL-workspace rows;
- change live file modes, tokens, callbacks, or database contents.
