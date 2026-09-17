# Qoopia 5.0.3 — release and deployment, 2026-09-15

Stable installers: https://github.com/qoopia/qoopia-downloads/releases/tag/v5.0.3
Public source: https://github.com/qoopia/qoopia-source/releases/tag/v5.0.3

## Delivered

Product source `279a2d62b576e760ac89d10d02b30b9ab0f96bb7` is shared by Mac/Linux packages, the installed owner Mac, memory/MCP and identity. Version 5.0.3; schema 43. Website source `4e92f3c63df9c7676208d6862f3cceaee14532ce`, deployment https://e13fc537.qoopia-site.pages.dev. Public source merge `460cb16e6dbe7b589785d118389ee56361cfda14` retains its independent public history. Later bookkeeping commits do not change the source of shipped artifacts.

Private PRs 36 and 37; public PRs 12 and 13 merged after their checks. Authorization helpers are consolidated, dashboard sessions and recall configuration extracted, unused code removed. The TypeScript graph check covers re-exports, mixed type/value imports and literal dynamic imports, and pins three existing cycles. Computed dynamic module paths are outside this static check. Release metadata authenticates both archived bundle inventories and requires matching version, source commit and source digest.

The public export's missing compose template was caught by CI and repaired with a portable, parameterized template before release. The public Dockerfile already required this file. Owner-specific configuration and private history were not exported.

## Verification

Pre-release gate at 20:50:59 UTC: canonical product and website main CI, public product main CI, both signed artifacts, all 11 uploaded asset hashes, Mac Gatekeeper/notarization, isolated signed upgrade and Linux install/doctor passed. Canonical Linux CI: 1342 pass, one deliberate storage-full skip; dedicated storage-full: 2 pass; bounded V4: 3 pass. Local Mac full suite: 1340 pass, one skip, zero failures. Different discovery counts reflect the runners; no failure is hidden by the count. Gitleaks found no leaks in the selected public diff.

After publication both installers were downloaded anonymously and their bytes/hashes matched. Live website manifest and signed Sparkle feed match the checked-in files. Native Sparkle on the owner Mac downloaded 5.0.3 and completed Install and Relaunch; installed build 1789504804 and full publisher inventory match the release. Code signature and Gatekeeper pass; owner login, Corsair selection and Liam remained present. A separate isolated upgrade from the older signed V1 package retained synthetic data, identity and configuration, with an idempotent repeat.

Post-deploy checks: memory readiness/version/source/schema/storage, identity health, dashboard, OAuth discovery and unauthorized access boundaries passed. Unauthenticated MCP and dashboard connection requests return 401. Monitor is OK with the exact package/runtime source. No synthetic writes or provider messages were sent to production.

## Recovery

Memory image `sha256:78965307f83932a05e637dea88785af73c357bfef8820ecf9178f03e7a490618`; identity image `sha256:ea458cc836ce6605ee5fb782b1d400fdc405fa87e653134bc6eb604165dfb31f`.

Memory backup integrity and restoration passed before cutover; offsite SHA256 `7467dfb6407576bb0516a3ecb11958221f081a6ec29c072167c51950f4ab59dd`. Identity login/events/analytics snapshots restored successfully. Old images and the previous identity container are retained. Any code rollback must preserve current data and post-release writes; do not replace a live database with the pre-release snapshot.

## Scope

Fresh interactive third-party sign-ins were not repeated; existing ChatGPT Web/Desktop qualification remains recorded separately, while isolated connection/OAuth/provider regressions passed for this release. Independent clean-OS coverage and login-item registration in a second macOS profile are not claimed. Optional Cloudflare/Resend analytics access remains unchanged. These are not new release failures.

Evidence: `../outputs/release-503-20260915`, including PRE-RELEASE-AUDIT.json, POST-RELEASE-AUDIT.json, package verification and actual Sparkle upgrade records.
