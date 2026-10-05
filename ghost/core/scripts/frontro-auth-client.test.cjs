const { test } = require('node:test');
const assert = require('node:assert/strict');
const load = () => import('../../../apps/admin/src/auth/frontro/moments/client.ts');

test('shared client uses the configured Moments API with credentials and CSRF', async t => {
  const { authRequest } = await load();
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  let captured;
  globalThis.fetch = async (url, options) => {
    captured = { url, options };
    return new Response(null, { status: 204 });
  };
  await authRequest('/auth/handoffs/test/approve', { code: 'ABCD1234' }, 'csrf', 20000, undefined,
    'https://api.moments.frontro.com');
  assert.equal(captured.url, 'https://api.moments.frontro.com/v1/auth/handoffs/test/approve');
  assert.equal(captured.options.credentials, 'include');
  assert.equal(captured.options.headers['X-CSRF-Token'], 'csrf');
  assert.equal(captured.options.body, '{"code":"ABCD1234"}');
});

test('shared modal presents a clear staff-access denial', async () => {
  const { authMessage, AuthError } = await load();
  assert.match(authMessage(new AuthError('frontro_staff_access_required', 403)), /does not have access/);
});

test('API provider failure and rate limits are errors, never successful login', async t => {
  const { authRequest, AuthError } = await load();
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async () => new Response('{"code":"rate_limited"}', {
    status: 429, headers: { 'Retry-After': '30' },
  });
  await assert.rejects(authRequest('/auth/challenges', { identity: 'fixture@example.test' },
    undefined, 20000, undefined, 'https://api.moments.frontro.com'),
  error => error instanceof AuthError && error.status === 429 && error.retryAfter === 30);
});

test('Gather OAuth returns through the admin entry point without a rejected fragment', async () => {
  const { gatherOAuthReturnURL } = await load();
  assert.equal(gatherOAuthReturnURL('https://gather.frontro.com/ghost/#/signin'),
    'https://gather.frontro.com/ghost/');
  assert.equal(gatherOAuthReturnURL('https://gather.frontro.com/blog/ghost/?secret=fixture#/signin'),
    'https://gather.frontro.com/blog/ghost/');
});
