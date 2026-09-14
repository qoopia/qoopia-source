# Export, import, backup, and disaster-recovery contract

## Bundle format

Format ID: `qoopia-v4-export/1`. The materialized bundle directory is rooted by `manifest.json`, `manifest.sig`, and deterministic `data/NNN-<table>.ndjson` files. `manifest.json` and every row are RFC 8785 canonical JSON encoded as UTF-8 without BOM. NDJSON has one canonical object plus byte `0x0a` per row; an empty table file is zero bytes. Every included/excluded logical table appears in the manifest with its schema version, policy, projection ID, order key, SHA-256 when a file exists, row count, and byte count.

Portable artifacts use one uncompressed POSIX ustar archive. Entries are unsigned-UTF-8 path ordered; directory entries precede descendants; `uid=gid=0`, names are empty, `mtime=0`, directories are mode `0700`, files are mode `0600`, and PAX/GNU extensions, sparse entries, symlinks, hard links, absolute paths, `..`, and compression are forbidden. `archive_sha256` hashes the exact tar bytes.

Rows use the table-specific ascending key in [export-table-policy.json](export-table-policy.json). Text uses SQLite `BINARY` order, integers numeric order, and composite keys lexicographic column order. Export runs against one SQLite read snapshot; pagination may not open a new snapshot.

`manifest.sig` is unpadded base64url Ed25519 signature bytes over the 32 raw bytes of `SHA-256(canonical manifest.json)`. `signature_key_id` is lowercase hexadecimal SHA-256 of the raw 32-byte Ed25519 public key. The manifest contains only algorithm `Ed25519`, digest algorithm `SHA-256`, and the key ID; private/public key material is not embedded. Export directories are `0700`; files are `0600`. The MCP response contains no path or bytes.

## Table policy

[export-table-policy.json](export-table-policy.json) is normative and classifies all 40 logical schema-32 tables exactly once as `required`, `optional_ephemeral`, `derived`, `forbidden`, `manifest_only`, or `local_config`. FTS5 shadow tables inherit their logical virtual table's `derived` policy. Unknown logical tables or columns make planning fail `UNSUPPORTED_SCHEMA`; P08 may not silently omit them.

The policy explicitly covers the previously ambiguous schema-26 state: sanitized `users`/`agents`, migration ledger, Claude Code host allowlist, OAuth tables/tickets, idempotency cache, synchronization conflict/applied-hash state, embeddings, wake telemetry, and recall log. It also covers every schema-32 table. Skills remain `entity_pages(type='skill')`. Secret/body-key scanning is fail-closed for workspace/agent metadata, wake/outbox payloads, and all other JSON metadata.

When ephemeral traces are excluded, required `recall_feedback` rows use projection `detach_ephemeral_trace_fk_v1`: the exported `trace_id` is null without mutating the source database. When traces are included, the original reference is preserved. Import validates the selected projection and may not invent a missing trace.

## Plan and conflict rules

All three MCP tools are admin-risk and require full profile, `mcp:admin`, owner/steward capability, canonical instance role, and exact AuthContext workspace. `target_workspace_id` on import must equal AuthContext workspace. Authorization and resource bindings are rechecked inside the plan/export transaction.

`export_plan` returns counts, policy decisions, estimated bytes, schema/format, a `plan_hash`, and an expiry; it returns no row body. The plan is valid for 15 minutes. Its canonical hash preimage binds format, schema 32, workspace ID, actor ID, include-ephemeral choice, policy-file SHA-256, release SHA, signing key ID, snapshot data-version, all table counts, and estimated bytes. `export_bundle` re-derives every bound field in one read snapshot; mismatch or expiry is `CONFLICT`, with no artifact.

The machine-readable result shapes are definitions `ExportPlanResponse`, `ExportBundleResponse`, and `ImportPlanResponse` in [v4-response-schemas.json](contracts/v4-response-schemas.json). The examples below are illustrative instances only:

<a id="export_bundle_response"></a>
```json
{"artifact_id":"opaque","format":"qoopia-v4-export/1","schema_version":32,"manifest_sha256":"64-hex","archive_sha256":"64-hex","signature_key_id":"64-hex","created_at":"ISO-8601"}
```

<a id="export_plan_response"></a>
```json
{"format":"qoopia-v4-export/1","schema_version":32,"counts":{},"policies":{},"estimated_bytes":0,"plan_hash":"64-hex","expires_at":"ISO-8601"}
```

`import_plan` resolves `signature_key_id` only through an operator-managed local trust store mapping key ID to raw public key. There is no trust-on-first-use, no key fetch, and no bundle-supplied key. Unknown/revoked keys are `UNTRUSTED_SIGNING_KEY`; rotation uses an explicit overlap allowlist with activation/revocation timestamps. It then verifies archive structure, signature, checksums, row counts, format, schema, projections, ordering, and all references before reporting:

<a id="import_plan_response"></a>
```json
{"artifact_id":"opaque","format":"qoopia-v4-export/1","schema_version":32,"signature_key_id":"64-hex","valid":true,"noops":0,"inserts":0,"conflicts":[],"missing_references":[],"apply_allowed":false}
```

Conflict rules are deterministic:

- same workspace-scoped ID and same canonical row hash: no-op;
- same ID and different hash: conflict, never overwrite;
- source/target workspace mismatch without an explicit plan mapping: conflict;
- agent identity maps only through a reviewed stable-ID mapping; names alone never merge identities;
- missing relation/provenance/message/file references: conflict;
- unknown format or source schema greater than 32: unsupported and invalid;
- checksum/signature mismatch: invalid and no partial plan acceptance.
- row-order, projection, archive-header, or undeclared-file mismatch: invalid and no partial plan acceptance.

Import apply is CLI/runbook-only. It requires owner GO, fresh verified backup, plan hash, reviewed release SHA, and transaction/chunk checkpoints. Dry-run and interrupted resume on clones must converge to the same logical hash.

## Backup and restore

Backup uses the SQLite backup API or `VACUUM INTO` against a read-only source handle, produces mode `0600`, records SHA-256 and `integrity_check=ok`, and never substitutes a plain copy of a live DB/WAL. Restore is rehearsed on another clone, verifies schema 32, foreign keys, counts, logical hashes, and legacy coverage, and must meet the 30-minute restore budget. Production restore is a separate owner-GO action.
