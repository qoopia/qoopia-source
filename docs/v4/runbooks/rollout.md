# Qoopia V4 controlled rollout

This runbook is bound to an exact reviewed candidate and immutable image. A branch name, mutable tag, wake callback, prose `DONE`, or unverified backup is never release evidence.

## Immutable coordinates

1. Freeze the candidate SHA and build the runtime image from a clean checkout with network disabled.
2. Record the image ID and verify `org.opencontainers.image.revision` equals the candidate SHA.
3. Preserve the accepted P09 base SHA, task `154d8f96` provenance, and the exact P10 Fable review artifact.
4. Keep `release/v4.0.0` local until the publish/tag action is explicitly executed. Push, publication, and any later rollout mutation remain separate owner-GO actions.

## Ring 0 — isolated production-size clone

- Use an existing verified production-size backup as a read-only source and copy it only into a disposable scratch directory.
- Run the exact candidate image with `--network none`; never mount `/srv/qoopia/data`, production logs, production exports, `.env`, credentials, or agent workspaces.
- Apply migrations 027–032 and the conservative V4 backfill only to the clone.
- Require schema 32, `integrity_check=ok`, zero FK violations, repeat migration/backfill no-op behavior, legacy coverage 943/943, V3 compatibility, flags-OFF and flags-ON holdout gates, and restore rehearsal below 30 minutes.
- Evidence contains counts, hashes, timings, image IDs, and command results only. Note bodies and secret values are forbidden.

## Ring 1 — sealed shadow

- Start the candidate image on the migrated private clone with an alternate internal port.
- Use container network `none`, publish no host port, and mount no production directory.
- Explicitly keep all V4 flags OFF. Wake delivery has no configured endpoint and network egress is unavailable; webhooks/event outbox remain OFF.
- Verify health status, exact release SHA, canonical role, schema 32 by read-only inspection, and the frozen V3 client/tool contract from inside the container.
- Stop and remove the disposable shadow after evidence capture. Its DB remains a scratch artifact only.

## Hard stop before Ring 2

Ring 2 changes the running production service and is not authorized by the offline P10 GO. Before any production backup, migration, backfill, compose install, deploy/restart, flag change, canary, AgentComm host-consumer action, or rollback:

1. obtain an action-specific owner GO artifact for the exact release SHA;
2. verify an exact-SHA `claude/claude-fable-5` PASS;
3. create and verify a 0600 backup no more than 30 minutes old;
4. verify current production health, integrity, restore rehearsal, immutable image, and sanctioned Compose runner;
5. run `scripts/v4-gate-verify.ts` in the same fail-closed command block.

The feature order is `RELATIONS` before `LATEST_ONLY`; read-only explain/dashboard precede lifecycle; extraction stays proposal-only; AgentComm consumers use transport idempotency keys because delivery is at-least-once. Event outbox/webhooks remain OFF absent separate egress authorization.

Native Codex, native Claude, ordinary Mako Telegram, and targeted request → ACK → same-session reply → close evidence are production-surface acceptance items for later GO-gated rings. Shell/HTTP substitutes and wake success are invalid evidence.
