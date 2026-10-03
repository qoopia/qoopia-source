# Source provenance — Qoopia 5.0.15

This repository has an independent public source history. Private development ancestry and customer data are excluded. Operator state is excluded by the export allowlist from 5.0.15 on: earlier releases carried some one-off operator scripts, host paths and internal identifiers, which this release removes from main (they remain in earlier history and tags).

- Product version: **5.0.15**; database schema **48**; instruction kit **9**.
- Reviewed source snapshot: `d655d94e5aca6b77cb65ad0e324ae0e2fab1e894` (runtime, migrations and SDK byte-identical to the package source).
- Signed Mac/Linux package source: `2a062e8f5662e49e33691902c8aa44cf330d8c1a`.
- Installers: [v5.0.15](https://github.com/qoopia/qoopia-downloads/releases/tag/v5.0.15).
- Native iOS: **5.0.8 build 3**, separate TestFlight channel. This release does not replace Apple's pending native build.

Runtime source is byte-identical to the signed package source. Later commits update publication metadata and acceptance records. SOURCE-MANIFEST.json records every distributed file and equality to the reviewed snapshot; RELEASE.json identifies the release for monitoring.

Public adaptations retained: contributor instructions, verified source-only schema-35 upgrade fixture, read-only CI token and shallow checkout, Docker verification from this repository's own history, parameterized historical compose, public README/release documentation. The public CI keeps the required check name `typecheck + tests` for pull requests from forks. No private Git history was exported. Public CI qualifies the source independently; it does not imply an Apple signature or hosted deployment.

The manifest excludes itself and this document to avoid self-reference.
