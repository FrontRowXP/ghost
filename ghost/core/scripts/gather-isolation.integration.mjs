// Disposable PostgreSQL only. Exercise real canonical tables and non-owner logins.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {randomBytes, randomUUID} from 'node:crypto';
const require = createRequire(import.meta.url);
const knex = require('knex');
const schema = require('../core/server/data/schema/schema');
const commands = require('../core/server/data/schema/commands');
const views = require('../core/server/data/schema/views');
const {installTenantIsolation, verifyTenantDatabase, TENANT_TABLES, tenantRole} = require('../core/server/lib/gather/database');
const {SiteRegistry} = require('../core/server/lib/gather/registry');
const {createStaffLogin} = require('../core/server/lib/gather/staff-login');
const migration = require('../core/server/data/migrations/versions/6.68/2026-10-05-19-39-53-add-shared-publication-tenancy-columns');
const base = {host: '127.0.0.1', port: 5432, user: 'gather_test', password: 'gather_test', database: 'gather_test'};

function record(table, overrides = {}) {
  const data = {};
  for (const [name, column] of Object.entries(schema[table])) {
    if (name.startsWith('@@') || column.nullable !== false || column.defaultTo !== undefined || name === 'site_id') continue;
    if (column.type === 'dateTime') data[name] = new Date();
    else if (column.type === 'boolean') data[name] = false;
    else if (['integer', 'bigInteger', 'float', 'decimal'].includes(column.type)) data[name] = 0;
    else data[name] = randomBytes(12).toString('hex').slice(0, column.maxlength || 24);
  }
  return {...data, ...overrides};
}

test('97 shared tables enforce immutable login isolation, scoped uniqueness, relations and privilege boundaries', async () => {
  assert.equal(process.env.GATHER_DISPOSABLE_CI, '1');
  assert.deepEqual([...TENANT_TABLES].sort(), Object.keys(schema).filter(name => !name.startsWith('gather_')).sort());
  const namespace = 'gather_isolation_' + randomBytes(6).toString('hex');
  const controlRole = 'gather_control_' + randomBytes(6).toString('hex');
  const ids = [randomUUID(), randomUUID()];
  const password = randomBytes(32).toString('hex');
  const operator = knex({client: 'pg', connection: base, searchPath: [namespace], pool: {min: 0, max: 2}});
  let control;
  const runtimes = [];
  try {
    await operator.raw('CREATE SCHEMA ??', [namespace]);
    await operator.raw(`CREATE ROLE ?? LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`, [controlRole]);
    // The migration owner creates canonical tables. Runtime users never run DDL.
    for (const name of Object.keys(schema)) await commands.createTable(name, operator);
    for (const [name, sql] of Object.entries(views)) await commands.createViewOrReplace(name, sql, operator);
    for (const [i, id] of ids.entries()) await operator('gather_sites').insert({id, workspace_id: randomUUID(), name: 'Site ' + i, slug: 'site-' + i, status: i ? 'provisioning' : 'active', created_by: randomUUID(), created_at: new Date(), updated_at: new Date()});
    await operator('settings').insert(record('settings', {key: 'title', value: 'Legacy'}));
    await migration.up({connection: operator}); // Already-created columns are preserved.
    await installTenantIsolation(operator, ids[0], controlRole);
    await installTenantIsolation(operator, ids[0], controlRole); // Operator retry.
    await assert.rejects(migration.down({connection: operator}), /refusing to remove site boundaries/);
    control = knex({client: 'pg', connection: {...base, user: controlRole, password}, searchPath: [namespace], pool: {min: 0, max: 2}});
    for (const id of ids) {
      await control.raw('SELECT gather_ensure_runtime_role(?, ?)', [id, password]);
      const runtime = knex({client: 'pg', connection: {...base, user: tenantRole(id), password}, searchPath: [namespace], pool: {min: 0, max: 2}});
      runtimes.push(runtime);
      await verifyTenantDatabase(runtime, id);
    }
    const [a, b] = runtimes;
    await operator.raw('CREATE POLICY unintended_public_access ON ??.tags USING (true)', [namespace]);
    await assert.rejects(verifyTenantDatabase(b, ids[1]), /policy differs/);
    await operator.raw('DROP POLICY unintended_public_access ON ??.tags', [namespace]);
    await verifyTenantDatabase(b, ids[1]);
    assert.equal((await a('settings').where({key: 'title'}).first()).value, 'Legacy');
    assert.equal((await b('settings')).length, 0);
    await b('settings').insert(record('settings', {key: 'title', value: 'Other'}));
    await a('settings').where({key: 'title'}).update({value: 'Original'});
    assert.equal((await b('settings').where({key: 'title'}).first()).value, 'Other');
    assert.equal(await b('settings').where({site_id: ids[0]}).del(), 0);
    await b.raw("SELECT set_config('gather.site_id', ?, false)", [ids[0]]);
    assert.equal((await b('settings').where({key: 'title'}).first()).value, 'Other');
    await assert.rejects(b('settings').insert(record('settings', {site_id: ids[0], key: 'injected'})), /row-level security/);
    const tagA = record('tags', {slug: 'same-slug', name: 'Original'});
    const tagB = record('tags', {slug: 'same-slug', name: 'Other'});
    await a('tags').insert(tagA);
    await b('tags').insert(tagB);
    const postB = record('posts', {slug: 'same-slug', title: 'Other', status: 'draft'});
    await b('posts').insert(postB);
    await assert.rejects(b('posts_tags').insert(record('posts_tags', {post_id: postB.id, tag_id: tagA.id})), /foreign key/);
    await b('posts_tags').insert(record('posts_tags', {post_id: postB.id, tag_id: tagB.id}));
    assert.deepEqual(await a('posts_tags'), []);
    const memberA = record('members', {email: 'shared@example.test'});
    const memberB = record('members', {email: 'shared@example.test'});
    await a('members').insert(memberA);
    await b('members').insert(memberB);
    await a('members_stripe_customers').insert(record('members_stripe_customers', {member_id: memberA.id, customer_id: 'cus_a'}));
    const subscription = record('members_stripe_customers_subscriptions', {customer_id: 'cus_a', status: 'active'});
    await a('members_stripe_customers_subscriptions').insert(subscription);
    assert.equal((await a('members_resolved_subscription')).length, 1);
    assert.deepEqual(await b('members_resolved_subscription'), []);
    const ownerA = record('users', {email: 'same@example.test', slug: 'owner', status: 'active'});
    const ownerB = record('users', {email: 'same@example.test', slug: 'owner', status: 'active'});
    await a('users').insert(ownerA);
    await b('users').insert(ownerB);
    await assert.rejects(b('sessions').insert(record('sessions', {user_id: ownerA.id})), /foreign key/);
    await a('jobs').insert(record('jobs', {name: 'scheduled-publishing'}));
    await b('jobs').insert(record('jobs', {name: 'scheduled-publishing'}));
    assert.equal((await a('jobs')).length, 1);
    assert.equal((await b('jobs')).length, 1);
    for (const runtime of runtimes) {
      await assert.rejects(runtime.raw('TRUNCATE tags'), /permission denied/);
      await assert.rejects(runtime.raw('CREATE TABLE escape(id text)'), /permission denied/);
      await assert.rejects(runtime.raw('SET ROLE ??', [controlRole]), /permission denied/);
      assert.deepEqual(await runtime('gather_site_staff'), []);
      await assert.rejects(runtime('gather_site_staff').insert({id: randomUUID(), site_id: ids[0], subject_id: randomUUID(), staff_id: ownerA.id}), /permission denied/);
      await assert.rejects(runtime.raw('SELECT gather_ensure_runtime_role(?, ?)', [ids[0], password]), /permission denied/);
    }
    await assert.rejects(control('tags').select('*'), /permission denied/);
    const existing = await control('gather_sites').where({id: ids[0]}).first();
    const principal = {user: {id: existing.created_by, name: 'Owner'}, workspaces: [{id: existing.workspace_id, name: 'Workspace', role: 'owner'}]};
    await control('gather_site_staff').insert({id: randomUUID(), site_id: ids[0], subject_id: principal.user.id, staff_id: ownerA.id});
    await control('gather_site_domains').insert({id: randomUUID(), site_id: ids[0], hostname: 'gather.example.test', verified_at: new Date(), is_primary: true});
    assert.equal((await a('gather_site_staff')).length, 1);
    assert.deepEqual(await b('gather_site_staff'), []);
    const queued = [];
    const registry = new SiteRegistry(control, {maximumSites: 3, hostname: slug => 'gather-' + slug + '.example.test', queue: site => queued.push(site.id)});
    const input = {workspaceId: existing.workspace_id, name: 'New publication', slug: 'new-publication'};
    const created = await registry.create(input, principal);
    const retried = await registry.create(input, principal);
    assert.equal(created.id, retried.id);
    assert.equal((await control('gather_sites').where({slug: input.slug})).length, 1);
    assert.equal((await registry.browse(principal)).length, 2); // Existing + own preparing site.
    await assert.rejects(registry.create({...input, slug: 'another'}, principal), error => error.code === 'site_capacity_reached');
    await assert.rejects(registry.create(input, {...principal, workspaces: [{...principal.workspaces[0], role: 'member'}]}), error => error.code === 'workspace_owner_required');
    await assert.rejects(registry.create({...input, name: 'Different'}, principal), error => error.code === 'site_address_in_use');
    const store = () => {
      const records = new Map();
      return {async reserve(token) {if (records.has(token)) return false; records.set(token, {}); return true;}, async put(token, value) {records.set(token, value);}, async get(token) {return records.get(token);}, async consume(token) {const value = records.get(token); records.delete(token); return value;}};
    };
    const login = createStaffLogin({database: control, registry, flows: store(), grants: store(), hubOrigin: 'https://gather.example.test'});
    let bindingCookie;
    let destination;
    const res = {cookie(name, value, options) {assert.equal(name, '__Host-gather-site-login'); assert.equal(options.path, '/'); bindingCookie = name + '=' + value;}, set() {}, redirect(value) {destination = value;}};
    await login.start({}, res, ids[0], 'gather.example.test');
    const flow = new URL(destination).searchParams.get('gatherLogin');
    assert.equal((await login.read(flow)).name, existing.name);
    const delegation = {cookie: '__Host-moments_session=' + 'b'.repeat(64), subject: principal.user.id, csrf: 'c'.repeat(64)};
    await assert.rejects(login.complete(flow, {...principal, workspaces: []}, delegation));
    const redirect = await login.complete(flow, principal, delegation);
    assert.ok(!redirect.includes('moments_session'));
    const req = {query: Object.fromEntries(new URL(redirect).searchParams), get: () => bindingCookie};
    await assert.rejects(login.consume({...req, get: () => ''}, 'gather.example.test', ids[0]));
    await assert.rejects(login.consume(req, 'gather-other.example.test', ids[0]));
    await assert.rejects(login.consume(req, 'gather.example.test', ids[1]));
    assert.deepEqual(await login.consume(req, 'gather.example.test', ids[0]), delegation);
    await assert.rejects(login.consume(req, 'gather.example.test', ids[0]));
  } finally {
    await Promise.all(runtimes.map(runtime => runtime.destroy()));
    if (control) await control.destroy();
    await operator.raw('DROP SCHEMA IF EXISTS ?? CASCADE', [namespace]);
    for (const id of ids) await operator.raw('DROP ROLE IF EXISTS ??', [tenantRole(id)]);
    await operator.raw('DROP ROLE IF EXISTS ??', [controlRole]);
    await operator.destroy();
  }
});
