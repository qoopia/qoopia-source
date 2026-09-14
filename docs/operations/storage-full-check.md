# Required storage-full check

The CI job runs two required test commands:

1. `bun test` runs the ordinary suite. The bounded SQLite-full fault is deliberately skipped in this shared process.
2. `bun run test:storage-full` runs `tests/p3-t27-sqlite-full.test.ts` with `QOOPIA_T27_SQLITE_FULL=true` in a new process. The test preload creates a fresh temporary database and removes it at exit. A failure fails the CI job; there is no `continue-on-error` or optional workflow condition.

The fault test caps SQLite's page count and writes synthetic notes until SQLite returns `SQLITE_FULL`. It verifies transaction atomicity, preservation and readability of earlier notes, `integrity_check=ok`, blocked subsequent writes, degraded health and `/ready` returning 503. It also checks that mock credentials and note text are not logged. The cap stays below 32 MiB and does not fill the host disk.

Run the second command separately when changing storage error handling, write guards, database transactions or readiness. A green ordinary suite with one skip does not qualify this fault: the separate CI step must also pass and emit `PASS_SOURCE_T27_SQLITE_FULL`.

This verifies the SQLite capacity error and its application handling. It is not evidence for every filesystem fault, physical disk exhaustion, read-only mounts or crash-recovery scenario. Never run a fault experiment against a user's installation.
