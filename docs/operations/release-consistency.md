# Release closure / Согласованность выпуска

A release is complete only after its delivered surfaces agree. A green build or a successful upload is not release closure.

1. Run `python3 scripts/check-release-metadata.py` (also required in CI). Package version, website metadata, Mac appcast, schema, current release notes and native iOS metadata must be consistent. Prepare these records together before publication.
2. Build and test the exact reviewed source. Preserve signed package hashes, publisher signatures and source SHAs. Never relabel an existing binary. Record runtime, package, public snapshot and website revisions separately: documentation/test-only commits can legitimately differ.
3. Export reviewed source files into the independent public repository. Never push private Git history. Update `SOURCE-MANIFEST.json`, `docs/SOURCE-PROVENANCE.md` and `RELEASE.json` (version, schema_version, package_source, source_snapshot). Scan the export and pass its own CI before merging and tagging its release.
4. Verify backup restoration before deploying memory/auth images. Keep the same data mounts and preserve credentials/connections. A same-schema rollback restores the image, not an older database over newer writes.
5. Publish installers, website and appcast; verify downloaded hashes and signatures. Update the monitor's explicit expected values only from verified delivery evidence.
6. Run `release-health.py` and require `status: OK` before declaring the release complete. It checks runtime/auth versions, schema and runtime SHA, website/package SHA, both public GitHub release tags, public source metadata and the signed Mac feed's version/URL/size. Failures are recorded in the existing monitor transition log. The external check is bounded and read-only.
7. Update `PROJECT-STATE.json` with actual delivered image/source values and evidence. Historical reports retain their original versions; START-HERE points to live status instead of repeating a stale release number.

## Monitor configuration

`QOOPIA_RELEASE_SHA` (runtime), `QOOPIA_PACKAGE_SOURCE` (signed package), `QOOPIA_RELEASE_VERSION`, `QOOPIA_SCHEMA_VERSION`, `QOOPIA_IOS_VERSION`, `QOOPIA_IOS_BUILD` are mandatory deployment inputs. A missing version/schema/beta record is a configuration error, not a healthy result.

Example invocation (values must come from the verified release):

```sh
python3 scripts/release-health.py --root /srv/qoopia-monitor \
  --source "$QOOPIA_RELEASE_SHA" --package-source "$QOOPIA_PACKAGE_SOURCE" \
  --version "$QOOPIA_RELEASE_VERSION" --schema-version "$QOOPIA_SCHEMA_VERSION" \
  --ios-version "$QOOPIA_IOS_VERSION" --ios-build "$QOOPIA_IOS_BUILD"
```

## Separate iOS beta channel

Apple reviews an exact native version/build. Do not withdraw a pending build or falsify its version just to match desktop packaging. `ios-release.json` records the native version/build and `preparing`, `review` or `available`; public availability requires a working TestFlight invitation and Apple approval, verified in App Store Connect. The monitor checks published metadata against the explicit expected beta, not Apple's private review state. Pending review must stay visible in the final report.

## Boundaries

Schema numbers, MCP protocol revisions, SDK versions and historical feature-flag names are separate compatibility identifiers, not product release numbers. Do not renumber them cosmetically. Client installations can remain older until their updater runs; a healthy delivery channel does not prove every user's installation has upgraded.

Public raw-source checks read the expected version tag, not a cached mutable branch response. Both GitHub latest-release redirects must also identify that same version, so an old tag cannot masquerade as the latest delivery. The public main branch is checked at release closure with fresh Git refs and tree equality; documentation-only commits may follow without rebuilding an immutable release.

## Repository fronts, mirror and review server

- All three repositories must lead to the current stable release: private `qoopia`, public `qoopia-source`, and `qoopia-downloads`. The private release is a pointer to the tested runtime source and public downloads; never publish private ancestry or duplicate/relabel binaries.
- The downloads README uses a latest-release badge and version-free download link. Its `RELEASE.json` must match the signed package's version, schema and source. The monitor checks this record, current headline/CTA claims, the public main package version and the production Pages alias.
- The isolated Apple-review **server** follows the stable server release with the same synthetic workspace, credentials and network restrictions. It is distinct from the native iOS binary Apple reviews. Back up and restore-test its database before replacing the image; qualify readiness inside its internal Docker network and then over the public HTTPS tunnel.
- `/srv/qoopia/git-mirror` is the active bare source mirror. `qoopia-source-mirror.timer` refreshes it every five minutes using the existing operator credential. It writes an atomic sync receipt only after comparing the fetched main with the remote. The health service reads that receipt without access to GitHub credentials and alerts on failed/stale sync (over ten minutes), a changed local ref or wrong product version.
- Historical source/build folders and rollback images are not delivery channels. Preserve uncommitted work; label their role in the operator inventory instead of resetting old worktrees or changing archived version numbers.
- At closure, inventory accessible repositories and running Qoopia services. Distinguish a verified machine installation from a published updater; an unreachable personal device must be reported as unverified.
