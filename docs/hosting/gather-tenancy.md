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
  matching wildcard origin TLS. Unknown/unverified hosts never resolve to a site.
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

## Recovery

Operator backups include both object prefixes, one exported PostgreSQL snapshot,
the isolation manifest, original migration/control identities, site IDs and table
counts. Database privileges are deliberately excluded; credentials stay private.

Restore into an isolated non-public recovery database as the original migration
owner. Create the original constrained control role before restoring because RLS
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
on any failed boundary. The current NAS multipart UploadPart timeout and abort
503 require infrastructure repair; a successful health read is insufficient.
