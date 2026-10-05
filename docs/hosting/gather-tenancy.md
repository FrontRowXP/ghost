# Gather tenancy rollout

The first implementation introduces a control-plane registry and a site hub.
It does **not** make the existing publication runtime multi-tenant. Core still
has process-wide settings, routing, models, sessions, jobs and service instances.
Creating a second publication remains disabled in both the API and UI.

## Implemented boundary

- The existing PostgreSQL database holds `gather_sites`, `gather_site_domains`
  and `gather_site_staff`. There is no database provisioned per site.
- Moments remains the authority for accounts and workspace membership. The hub
  rechecks `/v1/me` on every authenticated request and requires an explicit staff
  link before listing a publication. Workspace membership alone grants no Admin
  access. The existing Ghost staff session remains separate.
- Shared Redis stores bounded, encrypted hub sessions and one-use handoffs.
  Environment namespaces keep staging and production separate. Ciphertexts are
  bound to their record key, so copying one cannot change its browser binding.
- The hub is at `/ghost/#/sites`. It uses the existing Moments modal for signup
  and login, and shows a workspace selector, site list and disabled creation form.
  Its public capability is advertised only after successful opt-in initialization.
- Publication JSON exports exclude all platform registry records, including an
  explicit request to include them. Encrypted operator database backups retain
  the complete database as documented in [Gather hosting](gather.md).

## Opt-in requirements

Keep `gather.sites.enabled` false until PostgreSQL migration, external Redis and
real hub authentication have passed staging acceptance. The private runtime
configuration requires:

```json
{
  "gather": {
    "sites": {
      "enabled": true,
      "environment": "staging",
      "redis": {"host": "EXTERNAL_REDIS_HOST", "port": 6379},
      "sessionSealingKey": "PROJECTED_32_BYTE_HEX_KEY"
    }
  }
}
```

Project a cryptographically random 32-byte key as 64 lowercase hex characters;
the placeholder above intentionally fails validation. Project Redis credentials
and TLS options through the same private configuration. Production needs its
own key and namespace. Rotating the sealing key invalidates hub sessions.
The server also requires PostgreSQL, HTTPS and enabled Moments staff auth.

`SiteRegistry.registerExistingSite` is an operator-only bootstrap boundary,
not a public endpoint. Supply the verified immutable Moments subject, an owned
Moments workspace, an active local Ghost Owner, a stable site UUID and the
verified domain. Never choose a workspace from a browser-provided value or
auto-grant access by matching an email address. The first existing publication
uses the reserved `gather` slug. This method has not been applied to staging or
production as part of this source change.

## Remaining implementation gates

1. Inventory every publishing table, add `site_id`, backfill the existing site,
   and convert unique indexes and relationships to preserve site boundaries.
   Use a separate migration role and a non-owner runtime role without RLS bypass.
   Install and force PostgreSQL row security on the complete inventory.
2. Route all Bookshelf, raw Knex and service queries through a scoped transaction.
   The new context helper refuses to operate on unisolated publishing tables;
   it is not yet connected to the legacy query layer.
3. Replace global settings, routes, theme configuration and service instances with
   bounded tenant runtime objects. Resolve only verified registry domains through
   the trusted edge. Cover anonymous rendering as well as authenticated Admin.
4. Add tenant identity to every job, email, webhook, search index, cache key and
   scheduler lease. Enforce quotas and verify retry/restart behavior for two sites.
5. Namespace and authorize NAS objects, routes, redirects and CDN invalidation by
   site. Qualify upload, byte-range reads, private assets and deletion boundaries.
6. Implement idempotent provisioning and rollback, then test two independent
   owners publishing concurrently, switching sites, revocation, rescheduling,
   backup/restore and deletion. Remove creation blockers only after this passes.

CI exercises PostgreSQL registry upgrade/rollback, shared Redis concurrency,
context isolation, export exclusion, disabled API behavior, signup UI and older
backend compatibility. Its fixtures do not certify real multi-tenant publishing.
Production promotion retains the existing NAS, backup and staging acceptance
requirements in [Gather hosting](gather.md).
