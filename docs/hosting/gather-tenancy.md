# Gather shared tenancy

The shared runtime keeps the existing PostgreSQL database, 97 publication tables,
Redis, private S3 bucket and Kubernetes deployments. Each publication has `site_id`
and a bounded child process inside the existing shared Core deployment. No new
database, schema, pod or volume is created for a publication.

Source implementation and CI qualification are separate from commissioning.
Keep creation and production promotion disabled until real domain, NAS, owner
authentication and encrypted recovery acceptance pass. See [Gather hosting](gather.md).

## Boundaries

- PostgreSQL derives site identity from an immutable `gather_site_<UUID hex>`
  LOGIN, never a browser value or configurable connection variable. All 97 tables
  have forced RLS. Semantic uniqueness and foreign keys include `site_id`; views
  use invoker security. Runtime roles cannot own tables, assume roles, bypass
  RLS, create objects, truncate or modify platform staff grants. Startup audits
  actual role flags, memberships, policies, views and schema privileges.
- The constrained control role manages the registry and reads the staff roster.
  A constrained security-definer function issues fixed runtime roles. Migration
  credentials belong only to the offline operator. Both database fields in the
  supervisor configuration must use the control identity.
- Fixed workers contain independent models, settings, routes, themes, services,
  sessions and schedulers. Redis keys and S3 routes, redirects, images, media and
  files are namespaced. Existing content retains `content/`; new sites use
  `sites/<UUID>/content/`. Publication exports omit site IDs and platform records.
- Separate origins isolate tenant custom JavaScript. Staging uses
  `<slug>.gather-stage.frontro.com`; production uses `<slug>.gather.frontro.com`.
  Each zone needs DNS, CDN hostname preservation and origin authentication, and
  a matching edge wildcard certificate and verified origin TLS. Unknown/unverified
  hosts never resolve to a site.
- Moments signup/login stays on the trusted hub at `/ghost/#/sites`, using the
  same modal and API. Credentialed Moments CORS remains restricted to reviewed
  hub origins. A browser-, hostname- and site-bound one-use grant opens a site's
  host-only staff session. Access requires fresh workspace membership, an
  explicit immutable subject binding and an active local staff account.
- Workspace owners can reserve a name/address. Provisioning is durable,
  idempotent for the same owner/workspace/name/address, and capacity bounded.
  Staff access is granted after boot and a real edge HTTPS nonce challenge.
  Failed setup is visible and retryable with the same details; preparing sites
  expose no early Edit link. A Redis supervisor lease and parent-death IPC prevent
  duplicate pools. Restart rebuilds each site's signed schedules. Internal
  callbacks retain the canonical token audience and address their own worker.
- The two-GiB Core budget supports two sites. Increasing the limit up to eight
  requires reviewed memory resources. Startup rejects insufficient container
  capacity. No per-site infrastructure provisioning is exposed through HTTP.

## Offline installation

1. Qualify the exact source/image and commission each tenant DNS/CDN/TLS zone.
2. Drain all application database connections. Create and verify an encrypted
   database/NAS backup with the existing operator lane; retain its protected
   second copy and private `backup-attestation.json`.
3. Project a private operator JSON configuration with `operatorDatabase` (Knex
   PostgreSQL configuration for the migration owner), `controlRole`,
   `controlPassword`, `runtimeMasterKey`, `backupAttestationPath` and `enrollment`.
   Enrollment contains stable `siteId`, `workspaceId`, `subjectId`, `staffId`,
   `name` and existing verified `hostname`. Staff must be the existing active
   Owner and match the previously configured Moments subject binding. The
   command rechecks a current stored Moments session and owned workspace;
   email matching never grants access. Keys/passwords are random 32-byte hex;
   never commit or print them.
4. In the shipped Core directory, run
   `node scripts/gather-operator.mjs --mode install --config /private/operator.json`.
   It checks quiescence and the retained NAS-verified backup, runs canonical
   migrations once, registers the verified publication, installs transactional
   isolation and issues fixed runtime credentials.
5. Project the shared supervisor configuration through the existing private
   credential path. Root `database` and `controlDatabase` must both contain the
   same constrained control connection, never the migration identity.

```json
{
  "gather": {
    "sharedTenancy": {
      "enabled": true,
      "creationEnabled": false,
      "environment": "staging",
      "maximumSites": 2,
      "hostnamePrefix": "",
      "hostnameDomain": "gather-stage.frontro.com",
      "runtimeMasterKey": "PROJECTED_RANDOM_32_BYTE_HEX_KEY",
      "sessionSealingKey": "SEPARATE_PROJECTED_RANDOM_32_BYTE_HEX_KEY",
      "redis": {"host": "EXISTING_EXTERNAL_REDIS", "port": 6379},
      "controlDatabase": {"client": "pg", "connection": "PRIVATE_KNEX_CONNECTION_OBJECT"}
    }
  }
}
```

Placeholders intentionally fail validation. Preserve reviewed Redis credentials,
TLS, private S3 adapters, HTTPS URLs, Moments API and origin credential. Staging
and production require distinct keys, database/environment namespaces and DNS
zones while reusing the existing database infrastructure service.

Render with `infra/kubernetes/render.py --shared-tenancy --tenant-domain` equal to
the hub hostname and reviewed `--maximum-sites`. The runtime command is
`node index.js shared-tenancy`. Workers receive whitelisted private configurations,
non-owner roles and no migration capability. Enable `creationEnabled` only after
real two-site acceptance succeeds.

## Existing CDN commissioning

The existing services are `Gather Staging` (`aRKJKLitloQE3sW2X3l0dJ`) and
`Gather Production` (`tyetphulke2W2dD90fsLXA`). Commission staging first. Clone
its active Fastly version, preserving the origin credential without printing it.
Add `*.gather-stage.frontro.com` to that service. For production, use
`*.gather.frontro.com` in its separate service. Preserve the verified root domain.

Both current receive snippets and backend `override_host` rewrite all requests to
the hub hostname. Remove both rewrites for shared tenancy. Reject hosts outside
the corresponding hub/one-label tenant zone, preserve the validated request Host,
and preserve the HTTPS scheme and injected origin credential. Redirect HTTP to
`https://` plus that same validated hostname and request URL. Keep pass-through
behavior for publishing, authentication and assets; strip the origin credential
from responses. Validate the cloned version before activation.

Each tenant zone needs a Fastly edge wildcard certificate and its validation DNS.
The existing AWS key in `prod/channel/env` can configure both Gather services,
but its owner has the Engineer role. Even its global API scope does not grant TLS
administration: TLS subscription requests return HTTP 403. Use a TLS-capable
account in the existing Fastly customer; creating another account does not repair
these services. The saved account requires two-factor authentication before a
temporary commissioning token can be issued. Keep credentials out of logs.

The current hub certificate covers `*.frontro.com`, which does not cover the
deeper tenant addresses. Existing wildcard DNS already resolves
nested Gather names to Fastly, but it does not assign them to the Gather services
or provide a matching edge certificate. Existing origin SNI/certificate validation
may remain pinned to the verified hub while HTTP Host selects its tenant ingress;
otherwise provision the matching wildcard origin certificate before changing SNI.
Never disable origin certificate verification or its injected credential.

## Recovery

Operator backups include both object prefixes, one exported PostgreSQL snapshot,
the isolation manifest, original migration/control identities, site IDs and table
counts. Database privileges are deliberately excluded; credentials stay private.

Restore into a separate isolated, non-public PostgreSQL cluster as the original
migration owner. Role identities and passwords are cluster-wide: a recovery
database in the live cluster would alter live runtime credentials. Create the
original constrained control role before restoring because RLS
policies refer to it. Restore the decrypted snapshot with the matching PostgreSQL
client, preserving all policies/functions/data. Validate manifest, counts and
object hashes. Before exposing runtimes, run
`node scripts/gather-operator.mjs --mode restore-grants --config /private/operator.json`.
It revokes public role-issuer access, restores audited control ACLs and reissues
fixed worker privileges/passwords. Startup independently checks isolation.
Runtime/sealing key rotation safely invalidates browser sessions.

Registry/column rollback refuses to remove installed boundaries. Image rollback
does not undo this database transformation: retain a qualified shared-runtime
image or follow an explicit isolated restore procedure.

## Commissioning evidence

CI includes non-owner isolation across every table, scoped uniqueness/references,
staff-grant/role denial, policy tampering, actual two-process publishing, independent
uploads, restart, overdue schedules, pg_dump/pg_restore and restored privileges.
Browser acceptance includes signup, enabled creation, preparing state, address
conflicts and older backend compatibility. Disposable HTTP/S3 fixtures do not
certify real NAS or TLS.

Real staging acceptance must also prove independent owner login/revocation,
public HTTPS rendering, NAS multipart uploads/range reads/deletion, encrypted
asset/database recovery and provisioning failure/retry. Keep production disabled
on any failed boundary. The current NAS multipart UploadPart times out even for a 16-KiB part with both
SDK and legacy AWS CLI clients, while an ordinary five-MiB PutObject succeeds.
This isolates the failing multipart service path. Diagnostic objects/uploads were
removed. Inspect and repair the NAS service before qualification; successful
health reads or ordinary writes are insufficient.

The NAS runs RustFS 1.0.0. The failure also reproduces with NAS administrator
credentials, so Gather's restricted storage policy is not the cause. Read-only
container diagnostics found RustFS threads waiting on ext4 journal commits and
roughly 76% full host I/O pressure over five minutes, despite all three drives
being reported online. Do not infer storage readiness from that drive inventory.

The native signed admin API accepted a live scanner change to `speed=slow`,
`max_concurrent_disk_scans=1`, `max_concurrent_set_scans=1`, and `cycle=600`;
effective runtime settings report `source=config`. The previous scanner settings
were retained privately for rollback. A subsequent 16-KiB multipart part still
timed out after 30 seconds. This is pressure mitigation, not passing acceptance.
Existing scans may remain active until they finish. Check scanner activity, host
I/O pressure and journal waits before further changes; retain bitrot/heal
protection and inspect NAS storage diagnostics before attempting a restart or
filesystem repair. Repeat real multipart completion, range reads, deletion and
encrypted recovery only after the underlying I/O boundary passes.
