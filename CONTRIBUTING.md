# Contributing to Qoopia

Use an issue for a reproducible bug or a concrete proposal. Include your platform, Qoopia version, expected behavior and a minimal synthetic example. Do not attach credentials, personal memory, private conversations or a database dump. Report vulnerabilities through [SECURITY.md](SECURITY.md).

Keep pull requests focused. Explain the user-visible problem, the change and how you verified it. Preserve the existing brand and access boundaries. Distinguish a configured connection from a verified call, and a sent message from confirmed delivery.

Use Bun 1.3.11 and install with `bun install --frozen-lockfile`. Run the checks relevant to your change; CI runs type checking, lint, dependency checks, tests, the mandatory isolated `bun run test:storage-full` fault check and the bounded V4 qualification. Tests must use disposable data. Never connect tests to a real account or model subscription.

The source distribution includes a schema-35 code fixture for migration tests. Its source revision and SHA-256 are documented in `tests/fixtures/schema35-source.json`. Do not replace it with a database or import private development history.

Changes to schemas, authentication, bridges, backups or native execution need explicit negative-case and compatibility evidence. Release signing, production deployment and access changes are maintainer operations; a merged pull request does not perform them automatically.

Contributions are provided under the repository's MIT license. Keep third-party license notices intact. Be respectful and focus review comments on the work.
