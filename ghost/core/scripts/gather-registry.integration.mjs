// Disposable CI database/Redis only. Never run against a deployed environment.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID, randomBytes } from 'node:crypto';
const require = createRequire(import.meta.url);
const knex = require('knex');
const { SiteRegistry } = require('../core/server/lib/gather/registry');
const { SealedRedisStore } = require('../core/server/lib/gather/redis-store');
const { requireSiteContext } = require('../core/server/lib/gather/context');
const migration = require('../core/server/data/migrations/versions/6.68/2026-10-05-18-46-25-add-gather-site-registry');

test('PostgreSQL registry migrates, rolls back and respects membership, staff and verified domains', async () => {
  assert.equal(process.env.GATHER_DISPOSABLE_CI, '1');
  const schema = 'gather_test_' + randomBytes(8).toString('hex');
  const database = knex({
    client: 'pg',
    connection: {
      host: '127.0.0.1',
      port: 5432,
      user: 'gather_test',
      password: 'gather_test',
      database: 'gather_test',
    },
    searchPath: [schema],
  });
  try {
    await database.raw('CREATE SCHEMA ??', [schema]);
    await database.schema.createTable('users', (table) => {
      table.string('id', 24).primary();
      table.string('status');
    });
    await database.schema.createTable('roles', (table) => {
      table.string('id', 24).primary();
      table.string('name');
    });
    await database.schema.createTable('roles_users', (table) => {
      table.string('user_id', 24);
      table.string('role_id', 24);
    });
    await migration.up({ connection: database });
    await migration.up({ connection: database }); // Retry must preserve registry rows.
    const registry = new SiteRegistry(database);
    const [siteId, workspaceId, subjectId, outsider] = Array.from({ length: 4 }, randomUUID);
    const staffId = 'a'.repeat(24),
      roleId = 'b'.repeat(24);
    await database('users').insert({ id: staffId, status: 'active' });
    await database('roles').insert({ id: roleId, name: 'Owner' });
    await database('roles_users').insert({ user_id: staffId, role_id: roleId });
    const input = {
      siteId,
      workspaceId,
      subjectId,
      staffId,
      name: 'Gather',
      hostname: 'GATHER.example.test',
    };
    await registry.registerExistingSite(input);
    await registry.registerExistingSite(input);
    assert.equal((await database('gather_sites')).length, 1);
    const principal = {
      user: { id: subjectId, name: 'Fixture' },
      workspaces: [{ id: workspaceId, name: 'Workspace', role: 'owner' }],
    };
    assert.equal((await registry.browse(principal)).length, 1);
    assert.deepEqual(
      await registry.browse({ ...principal, user: { id: outsider, name: 'Other' } }),
      [],
    );
    assert.deepEqual(await registry.browse({ ...principal, workspaces: [] }), []);
    assert.equal((await registry.resolve('gather.example.test')).id, siteId);
    await registry.runForStaff(siteId, principal, async () =>
      assert.equal(requireSiteContext().siteId, siteId),
    );
    await assert.rejects(
      registry.runForStaff(siteId, { ...principal, workspaces: [] }, async () => {}),
    );
    await database('gather_site_domains').update({ verified_at: null });
    await assert.rejects(
      registry.resolve('gather.example.test'),
      (error) => error.statusCode === 404,
    );
    await database('users').update({ status: 'locked' });
    assert.deepEqual(await registry.browse(principal), []);
    await assert.rejects(registry.runForStaff(siteId, principal, async () => {}));
    // Exercise boot composition against the real migrated fixture database
    // and Redis. No deployment credentials or existing runtime are involved.
    const config = require('../core/shared/config');
    const db = require('../core/server/data/db');
    const descriptor = Object.getOwnPropertyDescriptor(db, 'knex');
    const settings = [
      'database:client',
      'url',
      'admin:url',
      'gather:sites',
      'security:frontroAuth',
    ];
    const prior = settings.map((key) => [key, config.get(key)]);
    const service = require('../core/server/services/gather-sites');
    try {
      Object.defineProperty(db, 'knex', { configurable: true, get: () => database });
      config.set('database:client', 'pg');
      config.set('url', 'https://gather.example.test');
      config.set('admin:url', 'https://gather.example.test');
      config.set('security:frontroAuth', {
        enabled: true,
        apiOrigin: 'https://moments.example.test',
      });
      config.set('gather:sites', {
        enabled: true,
        environment: 'staging',
        sessionSealingKey: 'a'.repeat(64),
        redis: { host: '127.0.0.1', port: 6379 },
      });
      await service.init();
      assert.deepEqual(service.getHub().capability, {
        apiOrigin: 'https://moments.example.test',
        creationEnabled: false,
        version: 1,
      });
      await service.init(); // Boot init is idempotent.
    } finally {
      await service.shutdown();
      Object.defineProperty(db, 'knex', descriptor);
      for (const [key, value] of prior) config.set(key, value);
    }
    await migration.down({ connection: database });
    for (const name of ['gather_sites', 'gather_site_domains', 'gather_site_staff'])
      assert.equal(await database.schema.hasTable(name), false);
  } finally {
    await database.raw('DROP SCHEMA IF EXISTS ?? CASCADE', [schema]);
    await database.destroy();
  }
});

test('real shared Redis enforces atomic capacity and one-use consumption across instances', async () => {
  assert.equal(process.env.GATHER_DISPOSABLE_CI, '1');
  const first = require('cache-manager-ioredis')
    .create({ host: '127.0.0.1', port: 6379 })
    .getClient();
  const second = require('cache-manager-ioredis')
    .create({ host: '127.0.0.1', port: 6379 })
    .getClient();
  const prefix = `gather:{ci-${randomBytes(8).toString('hex')}}:sessions`;
  const secret = randomBytes(32).toString('hex');
  const stores = [first, second].map((client) => new SealedRedisStore(client, prefix, secret, 1));
  const tokens = [randomBytes(32).toString('hex'), randomBytes(32).toString('hex')];
  try {
    const capacity = await Promise.all(
      stores.map((store, i) => store.reserve(tokens[i], Date.now() + 60000)),
    );
    assert.equal(capacity.filter(Boolean).length, 1);
    const index = capacity.indexOf(true);
    await stores[index].put(tokens[index], {
      expiresAt: Date.now() + 60000,
      cookie: 'private-fixture-cookie',
    });
    const consumed = await Promise.all(stores.map((store) => store.consume(tokens[index])));
    assert.equal(consumed.filter(Boolean).length, 1);
    assert.equal(consumed.find(Boolean).cookie, 'private-fixture-cookie');
    assert.equal(await stores[0].reserve(tokens[1 - index], Date.now() + 60000), true);
  } finally {
    await Promise.all(tokens.map((token) => stores[0].delete(token)));
    await first.del(prefix + ':pending');
    await Promise.all([first.quit(), second.quit()]);
  }
});
