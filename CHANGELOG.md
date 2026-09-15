# 5.0.3

- Consolidate authorization checks and preserve administrative write access consistently.
- Split dashboard sessions and recall configuration; remove unused code and reduce runtime dependency cycles.
- Parse runtime dependencies with TypeScript and reject new cycles.
- Authenticate packaged inventories and require matching source commits before generating release metadata.

# Changelog

## V4 Closeout - 2026-07-17

- finalized Qoopia V4 release closeout from accepted runtime SHA `9249309c69572f42a4cc8fa838f85089c93f39eb`
- live production runtime version at closeout remained `4.0.0-rc.1`; the `v4.0.0` release tag is created only after final independent PASS
- closed controlled rollout through production Rings 2-6 with schema 32, green `health`/`ready`, and global V4 behavior flags enabled
- kept `QOOPIA_V4_EVENT_OUTBOX=false` during closeout; external event egress remains separately authorized
- recorded fresh verified production backup `pre-v4-final-20260717T224608Z`
- published final release manifest, closeout draft, and P10/P11 checkpoints
