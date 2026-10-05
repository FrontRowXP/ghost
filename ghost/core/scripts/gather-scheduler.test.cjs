const { test } = require('node:test');
const assert = require('node:assert/strict');
const { tenantCallback } = require('../core/server/lib/gather/scheduler-callback');
const values = {
  'gather:tenant:siteId': 'fixed',
  url: 'https://gather-a.example.test',
  'server:host': '127.0.0.1',
  'server:port': 2370,
  'security:gatherOriginSecret': 'a'.repeat(64),
};
const config = { get: (key) => values[key] };
test('signed callbacks keep their token but cannot select another publication', () => {
  const result = tenantCallback(
    values.url + '/ghost/api/admin/schedules/posts/post/?token=signed',
    config,
  );
  assert.equal(
    result.url,
    'http://127.0.0.1:2370/ghost/api/admin/schedules/posts/post/?token=signed',
  );
  assert.equal(result.headers.Host, 'gather-a.example.test');
  assert.equal(result.headers['X-Gather-Origin-Key'], values['security:gatherOriginSecret']);
  for (const url of [
    'https://gather-b.example.test/ghost/api/admin/posts/',
    'https://gather-a.example.test/other/',
    'https://attacker.example/ghost/api/admin/posts/',
  ])
    assert.throws(() => tenantCallback(url, config), /fixed Admin runtime/);
});
