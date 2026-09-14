# Immutable V4 image and compose contract

The final image is built from a digest-pinned Bun base, runs typecheck/full tests in the verify stage, copies only runtime source/migrations/scripts/contracts/templates, installs production dependencies, stamps the exact SHA, and runs as UID 1000. It contains no `.git`, tests/fixtures, backups, caches, SDK build trees, or development node modules.

`compose/docker-compose.v4.yml` requires `QOOPIA_IMAGE` and never bind-mounts `/srv/qoopia/code`. It runs read-only with all capabilities dropped, `no-new-privileges`, loopback port binding, dedicated data/log/backup/export mounts, and read-only operator key files. The existing production compose remains untouched as rollback evidence.

Building an image is offline qualification. Installing compose, starting/restarting containers, applying migrations, or changing flags remains P10 owner-GO work.
