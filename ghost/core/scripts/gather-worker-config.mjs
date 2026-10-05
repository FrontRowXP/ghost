import { createHmac } from 'node:crypto';

export function deriveTenantCredential(masterKey, siteId, purpose = 'database') {
  if (
    !/^[a-f0-9]{64}$/.test(masterKey) ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(siteId)
  )
    throw new Error('Invalid fixed-site credentials');
  return createHmac('sha256', Buffer.from(masterKey, 'hex'))
    .update(`gather:${purpose}:${siteId}`)
    .digest('hex');
}

export function workerConfiguration({
  template,
  site,
  hostname,
  legacySiteId,
  ownerStaffId,
  password,
  bridgeSecret,
  port,
  contentPath,
}) {
  const hubOrigin = new URL(template.url).origin;
  if (
    !hubOrigin.startsWith('https://') ||
    !/^[a-f0-9]{64}$/.test(password) ||
    !/^[a-f0-9]{64}$/.test(bridgeSecret)
  )
    throw new Error('Invalid tenant configuration');
  // Project only reviewed runtime fields. Control DB credentials and master
  // sealing/derivation keys are never copied into a worker configuration.
  const allowed = [
    'mail',
    'logging',
    'imageOptimization',
    'storage',
    'adapters',
    'security',
    'hostSettings',
    'members',
    'limits',
    'paths',
    'bulkEmail',
    'scheduling',
    'sodoSearch',
    'portal',
    'adminToolbar',
    'analytics',
    'labs',
  ];
  const config = Object.fromEntries(
    allowed
      .filter((key) => Object.hasOwn(template, key))
      .map((key) => [key, structuredClone(template[key])]),
  );
  config.url = 'https://' + hostname;
  config.admin = { url: config.url };
  config.server = { host: '127.0.0.1', port };
  config.database = {
    ...structuredClone(template.database),
    connection: {
      ...structuredClone(template.database.connection),
      user: 'gather_site_' + site.id.replaceAll('-', ''),
      password,
    },
    pool: { min: 0, max: 4 },
    acquireConnectionTimeout: 8000,
  };
  delete config.database.connection.password_FILE;
  delete config.database.connection.filename;
  config.paths = { ...config.paths, contentPath };
  config.security = {
    ...config.security,
    frontroAuth: { enabled: true, apiOrigin: template.security.frontroAuth.apiOrigin },
  };
  config.gather = {
    tenant: {
      siteId: site.id,
      workspaceId: site.workspace_id,
      hubOrigin,
      bridgeSecret,
      bootstrap: site.status === 'provisioning',
      ownerStaffId,
      ownerSubject: site.created_by,
      ownerName: 'Frontro publisher',
      siteName: site.name,
      hubCapability: {
        apiOrigin: template.security.frontroAuth.apiOrigin,
        creationEnabled: true,
        version: 1,
      },
    },
  };
  const tenantPrefix = site.id === legacySiteId ? '' : 'sites/' + site.id;
  if (config.storage?.active !== 'S3Storage')
    throw new Error('Shared tenancy requires private S3 storage');
  config.storage.S3Storage = {
    ...config.storage.S3Storage,
    tenantPrefix,
    cdnUrl: config.url + '/_assets',
  };
  for (const feature of ['media', 'files']) {
    if (config.storage[feature]?.adapter !== 'S3Storage')
      throw new Error('Shared tenancy requires S3 for every public upload');
    config.storage[feature] = {
      ...config.storage[feature],
      tenantPrefix,
      cdnUrl: config.url + '/_assets',
    };
  }
  // Import staging is private and ephemeral within this worker's content path.
  config.storage.imports = { adapter: 'LocalStorageBase', staticFileURLPrefix: 'content/imports' };
  for (const [feature, adapter] of [
    ['route-settings', 'S3RouteSettingsStore'],
    ['redirects', 'S3RedirectsStore'],
  ]) {
    if (config.adapters?.[feature]?.active !== adapter)
      throw new Error('Shared tenancy requires namespaced routes and redirects');
    config.adapters[feature][adapter] = { ...config.adapters[feature][adapter], tenantPrefix };
  }
  const cache = config.adapters?.cache;
  if (cache) {
    for (const [feature, options] of Object.entries(cache)) {
      if (
        typeof options !== 'object' ||
        options === null ||
        (feature === 'settings' && options.adapter !== 'Redis')
      )
        continue;
      cache[feature] = {
        ...options,
        keyPrefix: `gather:${site.id}:${feature}:`,
        storeConfig: { ...options.storeConfig, keyPrefix: `gather:${site.id}:` },
      };
    }
    // Settings are synchronous and remain process-local.
    cache.settings = { adapter: 'MemoryCache' };
  }
  config.adapters.jobs = { active: 'InMemoryJobsBackend', InMemoryJobsBackend: { concurrency: 2 } };
  // Providers needing separate per-site credentials stay disabled until the
  // owner configures them. Publication, search and editing are available.
  config.members = { ...config.members, paymentProcessors: [] };
  config.sodoSearch = {
    url: config.url + '/public/gather-search/sodo-search.min.js',
    styles: config.url + '/public/gather-search/main.css',
  };
  config.explore = { update_url: null, testimonials_url: null };
  return config;
}
