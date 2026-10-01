# Gather hosting

This fork adds PostgreSQL support for Gather. Upstream Ghost supports MySQL in
production; PostgreSQL compatibility is maintained and tested by this fork.

## Deployment boundaries

- Run Core and its matching built Admin in the Kubernetes cluster.
- Run PostgreSQL and Redis on dedicated data hosts. Development and acceptance
  checks also use external, isolated databases; do not start the upstream Compose
  database or cache services on application nodes.
- Store images, media, files, routes and redirects through the S3 adapters.
- Project credentials from the local credential store. Keep environment files,
  private addresses, certificates and operator inventory outside this repository.
- Set `GATHER_REQUIRE_POSTGRES=true` in every Gather runtime to reject an
  accidental fallback to SQLite.
- Deploy immutable image digests. Build the `full` target in
  `Dockerfile.production` after building the matching Admin assets.

## Checks

The `Gather compatibility` pull request check needs no production credentials.
It builds the frontend/backend and runs focused configuration and publishing
regression tests on a hosted runner.

The trusted infrastructure acceptance lane must initialize an isolated database,
run `ghost/core/scripts/verify-postgres.mjs` with verified TLS configuration,
exercise authenticated publishing and Content API reads, and verify persistence
after restarting the application. The PostgreSQL script checks schema reflection,
migration lock exclusion, and rollback/upgrade of the latest migration. It does
not certify migration of arbitrary existing MySQL installations.

Before production promotion, verify actual NAS uploads, external Redis,
rescheduling, backup restore, and public HTTPS at `gather.frontro.com`. A successful
build or health response alone does not pass these gates. Mail, newsletters,
payments, analytics and federation need their own provider acceptance checks.

Upstream workflow definitions are retained under `.github/upstream-workflows/`
for reference. They are inactive. The active workflow lives in
`.github/workflows/gather.yml` and never publishes upstream packages or modifies
upstream services.
