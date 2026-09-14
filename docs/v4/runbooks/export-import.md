# Offline export and import-plan runbook

This runbook is scratch/clone-only until P10 owner GO. Never put signing-key material in command arguments, logs, artifacts, notes, or messages. Configure `QOOPIA_V4_EXPORT_SIGNING_KEY_FILE` and `QOOPIA_V4_EXPORT_PUBLIC_KEY_FILE` as local file paths with owner-only permissions.

1. Open a schema-32 clone, not production.
2. Run `bun scripts/v4-export.ts --db "$CLONE_DB" --output "$WORK/export" --manifest "$EVIDENCE/export.json"`.
3. Verify bundle directory/file modes are `0700`/`0600`, all 40 table policies appear, and the response exposes only the opaque artifact ID plus hashes.
4. Run `bun scripts/v4-import.ts --plan --bundle "$WORK/export" --db "$TARGET_CLONE" --report "$EVIDENCE/import-plan.json"`.
5. Treat an unknown table/column, untrusted key, signature/checksum/order/projection mismatch, path traversal, missing reference, workspace mismatch, or row conflict as fail-closed.

There is no `import_apply` MCP tool and this CLI has no apply mode. Production import remains a separately reviewed, action-specific owner-GO workflow with a fresh verified backup.
