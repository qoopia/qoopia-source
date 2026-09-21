# Source provenance — Qoopia 5.0.9

This repository is an independent public source history. It contains no private development ancestry, production databases, credentials or operator reports.

- Product version: **5.0.9**. Database schema: **46**.
- Reviewed source snapshot: `db34b883c5ec83e4d9834ccd365a9f8f2015a5a4`.
- Signed Mac/Linux package source: `ad2e43963873cca7d78acca04d9246f3aec7b39e`.
- Official installers: [v5.0.9](https://github.com/qoopia/qoopia-downloads/releases/tag/v5.0.9).
- Native iOS: **5.0.8, build 3**, separate TestFlight channel awaiting Apple review. Desktop release numbering does not change the uploaded native build.

`src/`, `migrations/`, `templates/` and `sdk/` are byte-identical to the reviewed source. Runtime roots also match the signed package source; later changes affect tests, publication metadata and operations checks. `SOURCE-MANIFEST.json` records every distributed file's hash and its equality to the snapshot. `RELEASE.json` is the small machine-readable release identity used by monitoring. Neither file changes the origin or signature of an existing installer.

Public adaptations: contributor instructions; source-only schema-35 upgrade fixture (checked by SHA-256); CI with read-only token and shallow checkout; Docker verification without private history; parameterized historical compose; public release notes. Historical source is included only as the audited test fixture. Private operator state, dated operational reports, host-specific status/synchronization helpers and private audit evidence are excluded. Two SQL-only query-plan fixtures needed by tests remain included.

The manifest excludes itself and this document to avoid self-reference. Public changes must pass public CI independently. Never merge or push private Git history into this repository. A successful source build does not imply Apple signature, notarization or hosted deployment.

## Monitor cache correction

Canonical `de41b500a75e8aebf5858d2f8b3d750311e956b1` reads immutable version-tag source metadata instead of a mutable branch cached by the GitHub CDN, and still requires both latest release tags to match. Only monitor/docs change; the reviewed 5.0.9 release snapshot and runtime roots remain unchanged. The manifest names this follow-up per changed file.
