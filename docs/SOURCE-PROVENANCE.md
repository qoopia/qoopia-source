# Source provenance

This public repository starts a new Git history for the source distribution. Private development history and operational records are not part of it. A public commit is therefore not the same Git object as the original release commit.

- Product: **Qoopia V1**, protocol `5.0.0-p3.0`, schema **43**.
- Original installer/runtime/account-service revision: `e250748e8f71383d89425ca6214cac6b21a2cfec`.
- Original site/monitor revision: `efb7a9272e137717d0a67925bc53067ec178ad26`.
- Current source snapshot: `73b7d152f52eea5bc79819bb74dbabd05834ad6f`.
- Existing signed packages: [v5.0.0-v1.20260914](https://github.com/qoopia/qoopia-downloads/releases/tag/v5.0.0-v1.20260914).

The original public snapshot preserved byte-identical `src/`, `migrations/` and `sdk/` files from the installer/runtime revision. The current source adds optional news subscriptions and a private owner dashboard to the account service, plus the aggregate analytics export. This follow-up changes account-service and shared brand CSS files; it does not rebuild the signed installers or replace the memory server. The memory schema remains 43. The machine-readable `SOURCE-MANIFEST.json` lists the public source files, their SHA-256 and original Git blob when present. It excludes itself and this document to avoid self-reference. Build/test helpers and public documentation are identified separately in that manifest.

Public-only changes are contributor documentation, minimal CI token permissions and the upgrade-test fixture loader. The schema-35 fixture contains only `src/` and `package.json` from revision `1fbfdfc0de7c01c9913eb48e7b948a9808baf2bc`; its checksum is in `tests/fixtures/schema35-source.json`. No private Git ancestor, database, credentials or account is needed to run it.

Historical audit bundles (except two SQL-only query-plan fixtures required by tests), operator state and host-specific analytics synchronization/status helpers are excluded. Source distributions do not contain publisher private keys or Apple signing credentials. A local build is not an official signed installer, and changing Git history does not change the signatures or provenance of the already published binaries.

For future releases, update this provenance record and the file manifest from the reviewed source. Never push private development branches or their history into this repository. Accept public contributions through reviewed pull requests and record their integration in the canonical development checkout.

The CI follow-up requires `bun run test:storage-full` after the ordinary suite. It changes test execution and documentation only; that historical follow-up preserved the original V1 runtime, migrations and SDK.

## Account-service follow-up

Revision `73b7d152f52eea5bc79819bb74dbabd05834ad6f` adds explicit optional news consent, anonymous signed-link unsubscribe, a manually invoked campaign sender and a restricted owner dashboard. See [the operations guide](operations/news-and-owner.md). Existing users are not subscribed automatically. Sending requires the operator’s public postal address and an explicitly approved campaign; provider acceptance is not inbox delivery. The file manifest marks original-runtime equality per file so current source cannot be mistaken for a rebuilt installer.

## Unified owner analytics

Revision `2b4035d97dfd04315c88d49d947b1763f3e2955c` adds repository-scoped owner analytics, preserved daily history and explicit unavailable/capped provider states. Metadata collection and the owner service change; signed installers and the memory runtime retain their original source. Private analytics reports and credentials are not included.

## Public explanation and discovery follow-up

Revision `f3fc3be7d109ee74ed956f3dd44ea0c9f2fcc49d` adds shared RU/EN product answers, public-site corrections and bounded discovery checks. It does not change the signed installers, memory runtime or account service. Editorial review is separate from consumer search visibility. Operator schedules and private observation bundles are excluded.

## Native desktop and responsiveness release

Canonical source `a8158244417912f3443891321a0e0ff026bd1e8c` fixes blocking native checks, background subscription setup, Telegram button updates and OAuth consent redirects. It adds the native Mac window, menu-bar controls and signed Sparkle updater. ChatGPT Web and Mac Desktop were qualified through isolated real-client write/read/idempotent replay. Existing apps need one manual app replacement to adopt Sparkle. Private operator state and acceptance conversations are excluded.

Signed old-to-new installer acceptance found a cleanly closed WAL compatibility case. Canonical `890b67154a57e77eabe9809274d5336078cf0e42` initializes SQLite sidecars through a query-only handle during the authorized update, preserves application rows and retains the writer barrier. A regression test covers absent WAL/SHM files.

Release website `359e9e7373e60817d36e78e05b7a335c9782d441` publishes 5.0.1 download hashes, the signed Sparkle feed and first-update instructions. Installer source remains `890b67154a57e77eabe9809274d5336078cf0e42`.

## Release 5.0.3

Canonical product source `279a2d62b576e760ac89d10d02b30b9ab0f96bb7`. Authorization consolidation, dashboard/recall module extraction, route regression coverage and authenticated release package verification. This update includes selected source files only; no private development ancestry or operator records. Installer publication is recorded separately.

The public compose template replaces owner-specific instance names and environment paths with operator parameters. It supplies the file already referenced by the public Dockerfile and rollback check. Public CHANGELOG contains only the current release notes; private historical operational notes are excluded.

5.0.3 website metadata and signed Sparkle feed match canonical website merge `4e92f3c`. Packaged product source remains `279a2d62b576e760ac89d10d02b30b9ab0f96bb7`.

## Qoopia 5.0.4

Canonical product source `c065704ddfe42e1338881d26d8bc249679b72851`. Telegram subscription recovery, persistent receipts, Stop and native Claude transcript preservation. Public history remains independent. Operator state, host-specific runbooks, private profiles and acceptance artifacts are excluded.

5.0.4 website metadata and signed updater feed use the published package source c065704; website-only locale and release-note updates do not change those package bytes.
