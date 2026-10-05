import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const {
  withSiteContext,
  requireSiteContext,
  withSiteTransaction,
} = require('../core/server/lib/gather/context');
const { SiteRegistry, canonicalHostname } = require('../core/server/lib/gather/registry');
const { SealedRedisStore } = require('../core/server/lib/gather/redis-store');
const { createSiteHub } = require('../core/server/services/gather-sites/hub');
const a = '11111111-1111-4111-8111-111111111111';
const b = '22222222-2222-4222-8222-222222222222';
const actor = '33333333-3333-4333-8333-333333333333';
const context = (siteId) => ({ siteId, workspaceId: a, actorId: actor });

test('site context is mandatory, immutable and isolated across concurrent work', async () => {
  assert.throws(requireSiteContext, /required/);
  await Promise.all(
    [a, b].map((site) =>
      withSiteContext(context(site), async () => {
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(requireSiteContext().siteId, site);
        assert.ok(Object.isFrozen(requireSiteContext()));
        assert.throws(
          () => withSiteContext(context(site === a ? b : a), () => {}),
          /Cannot change site/,
        );
      }),
    ),
  );
  assert.throws(requireSiteContext, /required/);
});

test('transactions deny privileged roles and unisolated publishing tables before running work', async () => {
  let ran = false;
  const database = (privileged) => ({
    client: { config: { client: 'pg' } },
    transaction: async (work) =>
      work({
        raw: async (sql) => ({
          rows: sql.includes('pg_roles') ? [{ rolsuper: privileged, rolbypassrls: false }] : [],
        }),
      }),
  });
  await withSiteContext(context(a), async () => {
    await assert.rejects(
      withSiteTransaction(database(true), async () => {
        ran = true;
      }),
      /bypass/,
    );
    await assert.rejects(
      withSiteTransaction(database(false), async () => {
        ran = true;
      }),
      /not installed/,
    );
  });
  assert.equal(ran, false);
});

test('domain resolution accepts canonical DNS names and rejects URL/header/path injection', () => {
  assert.equal(canonicalHostname('NEWS.Example.com'), 'news.example.com');
  for (const host of [
    'news.example.com:443',
    'https://example.com',
    'a.example/../b',
    'foo@bar.example',
    'a.example\nb.example',
    'a.example,b.example',
    '*.example.com',
    '-a.example.com',
    'localhost',
  ]) {
    assert.throws(() => canonicalHostname(host));
  }
});

test('site creation denies nonowners and never writes rows while isolation is incomplete', async () => {
  const registry = new SiteRegistry(() => {
    throw new Error('Unexpected database mutation');
  });
  const principal = (role) => ({
    user: { id: actor, name: 'Fixture' },
    workspaces: [{ id: a, name: 'Workspace', role }],
  });
  await assert.rejects(
    registry.create({ workspaceId: a }, principal('member')),
    (error) => error.statusCode === 403,
  );
  await assert.rejects(
    registry.create({ workspaceId: b }, principal('owner')),
    (error) => error.statusCode === 403,
  );
  await assert.rejects(
    registry.create({ workspaceId: a }, principal('owner')),
    (error) => error.code === 'site_creation_unavailable',
  );
});

class MemoryRedis {
  records = new Map();
  pending = new Map();
  async get(key) {
    return this.records.get(key) || null;
  }
  async set(key, value, ...options) {
    if (options.includes('XX') && !this.records.has(key)) return null;
    this.records.set(key, value);
    return 'OK';
  }
  async del(key) {
    this.records.delete(key);
  }
  async eval(script, count, ...args) {
    const keys = args.slice(0, count),
      values = args.slice(count);
    if (script.includes('ZREMRANGEBYSCORE')) {
      const [now, expiry, , max, value, token] = values;
      const pending = this.pending.get(keys[0]) || new Map();
      for (const [id, expires] of pending) if (expires <= now) pending.delete(id);
      if (pending.size >= max || this.records.has(keys[1])) return 0;
      this.records.set(keys[1], value);
      pending.set(token, expiry);
      this.pending.set(keys[0], pending);
      return 1;
    }
    const result = this.records.get(keys[0]);
    this.records.delete(keys[0]);
    this.pending.get(keys[1])?.delete(values[0]);
    return result || null;
  }
}
test('Redis records hide delegated cookies, authenticate ciphertext and consume once', async () => {
  const redis = new MemoryRedis();
  const store = new SealedRedisStore(redis, 'gather:{test}:handoffs', 'a'.repeat(64), 1, () => 100);
  const token = 'b'.repeat(64);
  assert.equal(await store.reserve(token, 1000), true);
  assert.equal(await store.reserve('c'.repeat(64), 1000), false);
  await store.put(token, { cookie: 'private-session-cookie', expiresAt: 1000 });
  assert.ok(
    [...redis.records.values()].every((value) => !value.includes('private-session-cookie')),
  );
  assert.equal((await store.get(token)).cookie, 'private-session-cookie');
  const wrongKey = new SealedRedisStore(
    redis,
    'gather:{test}:handoffs',
    'd'.repeat(64),
    1,
    () => 100,
  );
  await assert.rejects(wrongKey.get(token));
  const alternate = 'e'.repeat(64);
  redis.records.set(`gather:{test}:handoffs:record:${alternate}`, [...redis.records.values()][0]);
  await assert.rejects(store.get(alternate)); // A copied ciphertext cannot become a different browser session.
  const results = await Promise.all([store.consume(token), store.consume(token)]);
  assert.equal(results.filter(Boolean).length, 1);
});

test('new Moments accounts receive a hub session without any publication staff grant', async () => {
  const redis = new MemoryRedis();
  const secret = 'a'.repeat(64);
  const sessions = new SealedRedisStore(redis, 'gather:{test}:sessions', secret, 100, () => 100);
  const handoffs = new SealedRedisStore(redis, 'gather:{test}:handoffs', secret, 100, () => 100);
  let workspaceAllowed = true;
  const cookieJar = new Map();
  const req = {
    body: { workspaceId: a },
    get: (name) =>
      name === 'cookie'
        ? [...cookieJar].map(([k, v]) => `${k}=${v}`).join('; ')
        : name === 'origin'
          ? 'https://gather.example'
          : '',
  };
  const res = {
    set() {},
    cookie: (name, value) => cookieJar.set(name, value),
    clearCookie: (name) => cookieJar.delete(name),
    json(data) {
      this.body = data;
    },
    sendStatus(status) {
      this.status = status;
    },
  };
  const principal = () => ({
    user: { id: actor, name: 'New account', csrfToken: 'provider-csrf' },
    workspaces: workspaceAllowed ? [{ id: a, name: 'Workspace', role: 'owner' }] : [],
  });
  const fetch = async (url) => {
    if (url.endsWith('/auth/handoffs'))
      return new Response(
        JSON.stringify({ id: b, secret: 'c'.repeat(64), code: 'ABCD1234', expiresIn: 600 }),
        { headers: { 'Set-Cookie': '__Host-moments_flow=' + 'd'.repeat(64) } },
      );
    if (url.endsWith('/exchange'))
      return new Response('{"authenticated":true}', {
        headers: { 'Set-Cookie': '__Host-moments_session=' + 'e'.repeat(64) },
      });
    if (url.endsWith('/me')) return new Response(JSON.stringify(principal()));
    if (url.endsWith('/logout')) return new Response(null, { status: 204 });
    throw new Error('Unexpected provider request');
  };
  let browsed;
  const hub = createSiteHub({
    registry: {
      browse: async (value) => {
        browsed = value;
        return [];
      },
      create: new SiteRegistry(null).create,
    },
    sessions,
    handoffs,
    origin: 'https://gather.example',
    cookiePath: '/ghost',
    apiOrigin: 'https://moments.example',
    fetch,
    now: () => 100,
  });
  await hub.start(req, res);
  await hub.complete(req, res);
  await hub.session(req, res);
  assert.equal(res.body.user.id, actor);
  assert.equal(res.body.creationEnabled, false);
  assert.equal(req.session, undefined);
  assert.equal(cookieJar.has('ghost-admin-api-session'), false);
  assert.ok(!JSON.stringify(res.body).includes('provider-csrf'));
  await assert.rejects(hub.create(req, res), (error) => error.code === 'csrf_invalid');
  workspaceAllowed = false;
  await hub.browse(req, res);
  assert.deepEqual(browsed.workspaces, []);
});
