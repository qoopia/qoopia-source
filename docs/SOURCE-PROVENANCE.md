# Source provenance — Qoopia 5.0.23

This repository has an independent public source history. Private development ancestry and customer data are excluded. Operator state is excluded by the export allowlist from 5.0.15 on: earlier releases carried some one-off operator scripts, host paths and internal identifiers, which this release removes from main (they remain in earlier history and tags).

- Product version: **5.0.23**; database schema **55**; instruction kit **16**.
- Reviewed source snapshot: `a4510991974a80ebd7a9de9e90188a6b9bd6770e` (runtime, migrations and SDK byte-identical to the package source).
- Signed Mac/Linux package source: `e902e821f0b4091d19c1ce4684592774b55fa74d`.
- Installers: [v5.0.23](https://github.com/qoopia/qoopia-downloads/releases/tag/v5.0.23).
- Native iOS: **5.0.8 build 4**, separate TestFlight channel (public group). This release does not replace Apple's native builds.

Runtime source is byte-identical to the signed package source. Later commits update publication metadata and acceptance records. SOURCE-MANIFEST.json records every distributed file and equality to the reviewed snapshot; RELEASE.json identifies the release for monitoring.

Public CI runs the bounded V4 qualification with 5,000 background notes, a second advisory source (OSV-Scanner) and the official MCP server conformance suite, as the canonical CI does. The canonical full-history secret scan is not ported: this repository has its own history, whose reviewed findings are synthetic test strings and public keys. Public adaptations retained: contributor instructions, verified source-only schema-35 upgrade fixture, read-only CI token and shallow checkout, Docker verification from this repository's own history, parameterized historical compose, public README/release documentation. The public CI keeps the required check name `typecheck + tests` for pull requests from forks. No private Git history was exported. Public CI qualifies the source independently; it does not imply an Apple signature or hosted deployment.

The manifest excludes itself and this document to avoid self-reference.
