# Source provenance

This public repository starts a new Git history for the source distribution. Private development history and operational records are not part of it. A public commit is therefore not the same Git object as the original release commit.

- Product: **Qoopia V1**, protocol `5.0.0-p3.0`, schema **43**.
- Original installer/runtime/account-service revision: `e250748e8f71383d89425ca6214cac6b21a2cfec`.
- Original site/monitor revision: `efb7a9272e137717d0a67925bc53067ec178ad26`.
- Source snapshot and corrected agent documentation: `1f827b6a104d52234f8ee5a22cae47c9fedfcb1f`.
- Existing signed packages: [v5.0.0-v1.20260914](https://github.com/qoopia/qoopia-downloads/releases/tag/v5.0.0-v1.20260914).

All files under `src/`, `migrations/` and `sdk/` are byte-identical to the original installer/runtime revision. The machine-readable `SOURCE-MANIFEST.json` lists the public source files, their SHA-256 and original Git blob when present. It excludes itself and this document to avoid self-reference. Build/test helpers and public documentation are identified separately in that manifest.

Public-only changes are contributor documentation, minimal CI token permissions and the upgrade-test fixture loader. The schema-35 fixture contains only `src/` and `package.json` from revision `1fbfdfc0de7c01c9913eb48e7b948a9808baf2bc`; its checksum is in `tests/fixtures/schema35-source.json`. No private Git ancestor, database, credentials or account is needed to run it.

Historical audit bundles, operator state and host-specific analytics synchronization/status helpers are excluded. Source distributions do not contain publisher private keys or Apple signing credentials. A local build is not an official signed installer, and changing Git history does not change the signatures or provenance of the already published binaries.

For future releases, update this provenance record and the file manifest from the reviewed source. Never push private development branches or their history into this repository. Accept public contributions through reviewed pull requests and record their integration in the canonical development checkout.
