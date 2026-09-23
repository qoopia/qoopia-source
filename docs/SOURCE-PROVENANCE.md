# Source provenance — Qoopia 5.0.11

This repository is an independent public source history. It contains no private development ancestry, production databases, credentials or operator reports.

- Product version: **5.0.11**. Database schema: **46**.
- Reviewed source snapshot: `1a6c63818a6282d2aa2ab0fea8502fd16e63184f`.
- Signed Mac/Linux package source: `47a842fbecd32e575c1e63f5eaf34d11eb89b91d`.
- Official installers: [v5.0.11](https://github.com/qoopia/qoopia-downloads/releases/tag/v5.0.11).
- Native iOS: **5.0.8, build 3**, separate TestFlight channel awaiting Apple review. Desktop release numbering does not change the uploaded native build.

`src/`, `migrations/`, `templates/` and `sdk/` are byte-identical to the reviewed source. Runtime roots also match the signed package source; later changes affect tests, publication metadata and operations checks. `SOURCE-MANIFEST.json` records every distributed file's hash and its equality to the snapshot. `RELEASE.json` is the small machine-readable release identity used by monitoring. Neither file changes the origin or signature of an existing installer.

Public adaptations: contributor instructions; source-only schema-35 upgrade fixture (checked by SHA-256); CI with read-only token and shallow checkout; Docker verification without private history; parameterized historical compose; public release notes. Historical source is included only as the audited test fixture. Private operator state, dated operational reports, private audit evidence are excluded. Two SQL-only query-plan fixtures needed by tests remain included.

The manifest excludes itself and this document to avoid self-reference. Public changes must pass public CI independently. Never merge or push private Git history into this repository. A successful source build does not imply Apple signature, notarization or hosted deployment.

## Discovery check update — 2026-09-22

The bounded discovery checker now includes the published `/mobile` page and accepts the current six-page sitemap while rejecting unexpected routes. Only `scripts/discovery-audit.py` and `tests/test_discovery.py` are copied from canonical change `7d055b7`; their per-file hashes are updated. Runtime and installer provenance above are unchanged.
