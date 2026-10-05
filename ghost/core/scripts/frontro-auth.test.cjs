const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createFrontroAuth, publicConfiguration } = require('../core/server/services/auth/frontro-auth');

const subject = '12345678-1234-1234-1234-123456789abc';
const id = '87654321-4321-4321-4321-cba987654321';
const flowToken = 'a'.repeat(64);
const sessionToken = 'b'.repeat(64);
const secret = 'c'.repeat(64);
const origin = 'https://gather.frontro.com';
function session(data = {}) {
  return { ...data, save(callback) { callback(); } };
}
function setup({ active = true, linked = true } = {}) {
  const config = { enabled: true, apiOrigin: 'https://api.moments.frontro.com', staff: linked ? { [subject]: 'staff-id' } : {} };
  const calls = [];
  let clock = 100;
  let failMe = false;
  const req = { session: session(), get: () => origin };
  const res = { set() {}, json(value) { this.body = value; } };
  const user = { id: 'staff-id', get: key => key === 'status' ? active ? 'active' : 'inactive' : null };
  let assigned = 0;
  const bridge = createFrontroAuth({
    getConfig: () => config, getAdminOrigin: () => origin,
    getSession: async req => req.session, findUserById: async id => id === user.id ? user : null,
    createSession: async req => { assigned++; req.session = session({ user_id: user.id }); },
    now: () => clock,
    fetch: async (url, options) => {
      calls.push({ url, options });
      if (url.endsWith('/auth/handoffs')) return new Response(JSON.stringify({ id, secret, code: 'ABCD1234', expiresIn: 600 }),
        { status: 201, headers: { 'Set-Cookie': '__Host-moments_flow=' + flowToken + '; Path=/; Secure; HttpOnly' } });
      if (url.endsWith('/exchange')) return new Response(JSON.stringify({ authenticated: true }),
        { headers: { 'Set-Cookie': '__Host-moments_session=' + sessionToken + '; Path=/; Secure; HttpOnly' } });
      if (url.endsWith('/me')) {
        if (failMe) return new Response('{}', { status: 503 });
        return new Response(JSON.stringify({ user: { id: subject, csrfToken: 'csrf' } }));
      }
      if (url.endsWith('/logout')) return new Response(null, { status: 204 });
      throw new Error('Unexpected request');
    },
  });
  return { bridge, config, req, res, calls, assigned: () => assigned,
    expire: () => { clock += 600001; }, outage: () => { failMe = true; } };
}

test('configuration is opt-in, HTTPS-only and never publishes staff links', () => {
  assert.equal(publicConfiguration(), null);
  assert.deepEqual(publicConfiguration({ enabled: true, apiOrigin: 'https://api.moments.frontro.com', staff: { secret: 'private' } }),
    { apiOrigin: 'https://api.moments.frontro.com' });
  for (const apiOrigin of ['http://example.com', 'https://user:pass@example.com', 'https://example.com/api', 'https://example.com/?key=secret']) {
    assert.throws(() => publicConfiguration({ enabled: true, apiOrigin }));
  }
});

test('one-use handoff stays server-side and issues only a linked staff session', async () => {
  const t = setup();
  await t.bridge.start(t.req, t.res);
  assert.deepEqual(t.res.body, { id, code: 'ABCD1234' });
  assert.equal(t.req.session.frontroHandoff.secret, secret);
  await t.bridge.complete(t.req, t.res);
  assert.equal(t.assigned(), 1);
  assert.deepEqual(t.res.body, { authenticated: true });
  assert.equal(t.req.session.frontroHandoff, undefined);
  assert.equal(t.req.session.frontroSession.subject, subject);
  assert.equal(t.calls[1].options.headers.Cookie, '__Host-moments_flow=' + flowToken);
  assert.equal(t.calls[2].options.headers.Cookie, '__Host-moments_session=' + sessionToken);
  assert.ok(t.calls.every(c => c.options.redirect === 'error' && c.options.headers.Origin === origin));
  await assert.rejects(t.bridge.complete(t.req, t.res), { message: 'frontro_handoff_expired' });
  assert.equal(t.assigned(), 1);
});

for (const options of [{ linked: false }, { active: false }]) {
  test('denies unlinked or inactive users and revokes their temporary upstream session: ' + JSON.stringify(options), async () => {
    const t = setup(options);
    await t.bridge.start(t.req, t.res);
    await assert.rejects(t.bridge.complete(t.req, t.res), { statusCode: 403, message: 'frontro_staff_access_required' });
    assert.equal(t.assigned(), 0);
    assert.ok(t.calls.at(-1).url.endsWith('/logout'));
    assert.equal(t.req.session.frontroHandoff, undefined);
  });
}

test('rejects login CSRF before any API request, and rejects expired handoffs', async () => {
  const t = setup();
  t.req.get = () => 'https://attacker.example';
  await assert.rejects(t.bridge.start(t.req, t.res), { statusCode: 403 });
  await assert.rejects(t.bridge.complete(t.req, t.res), { statusCode: 403 });
  assert.equal(t.calls.length, 0);
  t.req.get = () => origin;
  await t.bridge.start(t.req, t.res);
  t.expire();
  await assert.rejects(t.bridge.complete(t.req, t.res), { statusCode: 401 });
  assert.equal(t.calls.length, 1);
});

test('checks the provider and current staff mapping on protected requests', async () => {
  const t = setup();
  await t.bridge.start(t.req, t.res);
  await t.bridge.complete(t.req, t.res);
  assert.equal(await t.bridge.validate(t.req.session), true);
  delete t.config.staff[subject];
  assert.equal(await t.bridge.validate(t.req.session), false);
  t.config.staff[subject] = 'staff-id';
  t.outage();
  await assert.rejects(t.bridge.validate(t.req.session), { statusCode: 503 });
  assert.ok(t.req.session.frontroSession);
  t.config.enabled = false;
  assert.equal(await t.bridge.validate(t.req.session), false);
});

test('sign-out sends only the delegated cookie and CSRF token to the fixed provider', async () => {
  const t = setup();
  await t.bridge.start(t.req, t.res);
  await t.bridge.complete(t.req, t.res);
  await t.bridge.revoke(t.req.session.frontroSession);
  assert.ok(t.calls.at(-1).url.endsWith('/logout'));
  assert.equal(t.calls.at(-1).options.headers['X-CSRF-Token'], 'csrf');
  assert.equal(t.calls.at(-1).options.headers.Cookie, '__Host-moments_session=' + sessionToken);
});
