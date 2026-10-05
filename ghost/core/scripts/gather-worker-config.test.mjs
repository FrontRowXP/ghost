import {test} from 'node:test';
import assert from 'node:assert/strict';
import {deriveTenantCredential, workerConfiguration} from './gather-worker-config.mjs';
import {validateRuntimeCapacity} from './gather-supervisor.mjs';

test('a two-GiB shared pod cannot silently accept eight publication processes', () => {
  assert.doesNotThrow(() => validateRuntimeCapacity(2, 2 * 1024 ** 3));
  assert.throws(() => validateRuntimeCapacity(8, 2 * 1024 ** 3), /memory budget/);
  assert.doesNotThrow(() => validateRuntimeCapacity(8, 8 * 1024 ** 3));
});

test('worker projection fixes identity and isolates object/cache namespaces without control credentials', () => {
  const a = '12345678-1234-1234-1234-123456789abc';
  const b = '87654321-4321-4321-4321-cba987654321';
  const template = {url: 'https://gather.example.test', database: {client: 'pg', connection: {host: 'database.example.test', user: 'operator', password: 'operator-secret'}}, security: {gatherOriginSecret: 'o'.repeat(64), frontroAuth: {enabled: true, apiOrigin: 'https://moments.example.test', staff: {private: 'link'}}}, gather: {sharedTenancy: {runtimeMasterKey: 'private-master'}}, storage: {active: 'S3Storage', S3Storage: {bucket: 'shared'}, media: {adapter: 'S3Storage', staticFileURLPrefix: 'content/media'}, files: {adapter: 'S3Storage', staticFileURLPrefix: 'content/files'}}, adapters: {cache: {active: 'Redis', Redis: {host: 'redis.example.test'}, settings: {adapter: 'MemoryCache'}, postsPublic: {adapter: 'Redis'}}, 'route-settings': {active: 'S3RouteSettingsStore', S3RouteSettingsStore: {}}, redirects: {active: 'S3RedirectsStore', S3RedirectsStore: {}}}};
  const master = 'a'.repeat(64);
  const parameters = {template, site: {id: a, workspace_id: b, name: 'Example', created_by: b, status: 'provisioning'}, hostname: 'gather-example.example.test', legacySiteId: b, ownerStaffId: 'b'.repeat(24), password: deriveTenantCredential(master, a), bridgeSecret: 'c'.repeat(64), port: 2370, contentPath: '/tmp/private-site/content'};
  const result = workerConfiguration(parameters);
  assert.equal(result.database.connection.user, 'gather_site_' + a.replaceAll('-', ''));
  assert.ok(!JSON.stringify(result).includes('operator-secret'));
  assert.ok(!JSON.stringify(result).includes('private-master'));
  assert.equal(result.security.frontroAuth.staff, undefined);
  assert.equal(result.storage.S3Storage.tenantPrefix, 'sites/' + a);
  assert.equal(result.storage.media.tenantPrefix, 'sites/' + a);
  assert.equal(result.adapters['route-settings'].S3RouteSettingsStore.tenantPrefix, 'sites/' + a);
  assert.match(result.adapters.cache.postsPublic.keyPrefix, new RegExp(a));
  assert.equal(result.adapters.cache.settings.adapter, 'MemoryCache');
  assert.notEqual(deriveTenantCredential(master, a), deriveTenantCredential(master, b));
  assert.notEqual(deriveTenantCredential(master, a, 'owner'), deriveTenantCredential(master, a));
  const legacy = workerConfiguration({...parameters, legacySiteId: a});
  assert.equal(legacy.storage.S3Storage.tenantPrefix, '');
});
