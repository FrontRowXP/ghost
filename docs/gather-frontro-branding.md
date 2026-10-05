# Gather public branding

Gather presents Frontro branding in the bundled Source/Casper footers, member
Portal, private-site screen, newsletter footer and preview, staff email templates,
Admin titles/loading screens/setup/settings, public staff toolbar, and fallback site icons. Authentic
Frontro icon/wordmark assets are copied from the Moments assets. Custom site logos
and icons continue to override fallbacks.

The image applies `frontro-theme-branding.mjs` only to its release-managed default
themes before copying `base_content`. The Kubernetes init container copies those
themes into the read-only theme volume each rollout. The upstream submodules and
customer themes/content are not modified. An unexpected upstream footer fails the
build. Arbitrary third-party themes require an explicit theme customization.

Frontro-enabled Gather uses its bundled Portal instead of the default upstream CDN
URL. Custom Portal URLs and older backends retain their configured integration.
The full image carries the tested Portal and staff-toolbar bundles and an allow-list of public brand
assets. The existing NAS and authentication deployment gates remain mandatory.

Internal package/import names, Ghost API routes/attributes, database contracts,
third-party service identities, migration-source names, upstream author metadata,
linked copyright/license/trademark notices, and developer documentation remain accurate.
These are not product attribution. Marketplace and publisher-directory links use
neutral labels and continue to identify their actual destination.

Validation: CI builds Admin/Core and Portal, tests the exact pinned theme footers,
custom-theme preservation, build failure for unsupported upstream templates,
public footer attribution, and retained licensing. Production promotion still
requires passing the runtime upload/backup checks.
