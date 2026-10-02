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

## Kubernetes and private NAS delivery

Render the Kubernetes resources with `infra/kubernetes/render.py`. Supply the
namespace, hostname, immutable image, external data host addresses and eligible
node names. The renderer creates application workloads only. Project
`gather-runtime`, `gather-assets`, `gather-registry` and `gather-origin-tls` from
the local credential store before applying it.

Core is a singleton using the Recreate strategy. The matching Admin and default
themes are shipped in the same image. Themes are release-managed and mounted
read-only; install custom themes through reviewed image changes. Admin theme
uploads cannot persist in this deployment. Route settings and redirects use S3.

The separate asset gateway has only S3 GetObject access to images, media and
files. It rejects other prefixes and validates the origin credential on asset
requests. Core validates the same locally projected credential before routing
requests. Its authenticated readiness probe reads the credential from the mounted
configuration. Project the same strong per-environment value into Core's
`security.gatherOriginSecret` and the gateway's `assets.originSecret`.
`GATHER_REQUIRE_ORIGIN=true` makes missing or weak Core credentials a startup
error. Credentials never appear in the rendered resources. Keep buckets private, verify the origin TLS
certificate at the CDN, and overwrite the origin header at the edge. Start
with CDN pass-through for the application/API until cache invalidation is
qualified. Uploaded assets carry a 60-second browser cache lifetime.

When replacing a prior ingress authorization middleware, keep that middleware
active until both new services are ready and reject requests without the edge
credential. Remove the old ingress annotation only after those checks pass.

For an initial publishing-only launch, disable member signup using the
`members_signup_access` setting and remove signup links from secondary navigation.
Review the starter social account links before publishing the site. Payments,
newsletters, analytics and federation require separate acceptance before enabling
their visitor controls.

The full image includes the pinned site-search app at
`/public/gather-search/sodo-search.min.js` and its sibling `main.css`. Configure
`sodoSearch.url` and `sodoSearch.styles` to those URLs on the site's own origin.
Build it with `pnpm --filter @tryghost/sodo-search run build` before building the
full Docker image. Verify the search dialog in the browser after deployment.

Ghost's settings cache uses synchronous reads and must retain the process-local
MemoryCache adapter. Use external Redis for supported asynchronous cache
features. This does not require a Redis server in any application pod.

## Deployment after merges

The trusted `infra/deployer/watch.py` worker checks for a new main SHA every two
minutes. It requires a successful main push run of Gather checks, checks out
that exact SHA, builds/tests on infrastructure, pushes an immutable image, and
runs authenticated staging acceptance before promotion. Production commissioning
must explicitly enable promotion in the private operator configuration.

The acceptance lane publishes and unpublishes a disposable post and verifies
image, file, multipart video and byte-range delivery. It removes its own test
post and upload objects afterward. A failed production check restores the
previous image; it never automatically reverses a database migration. Review
schema compatibility and restore procedures before every schema change.
Failed staging qualification also restores the previous staging image and keeps
production unchanged. Commissioning with production promotion disabled records a
qualified staging release separately from a completed production deployment.

Before promotion, the backup lane creates an encrypted PostgreSQL and NAS
snapshot, verifies the uploaded encrypted bytes, and retains a protected second
copy. Snapshots have a 2 GiB plaintext bound and require 20 GiB free disk space;
exceeding either limit stops promotion. Store the encryption passphrase and
scoped backup credentials in the local credential store. Rehearse decryption,
PostgreSQL restore and asset recovery independently; byte verification alone
does not prove restore readiness.

Install the supplied systemd units with a reviewed operator account override.
Give its Kubernetes identity access to the Gather deployments only, keep
configuration files private, and retain the existing GitHub App wrapper for
Actions reads. The worker updates application images; changes to networking,
credential projection or infrastructure require the operator deployment path.

The optional `gather-backup.timer` also runs the encrypted snapshot daily at
03:40 UTC, with up to five minutes of jitter. Override its operator account and
Node executable path to use the pinned runtime. Check the first real run before
enabling the timer and monitor service failures and disk reserve. Retention is
operator-managed; the backup identity cannot delete snapshots.
