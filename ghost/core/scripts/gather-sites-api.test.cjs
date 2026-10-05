const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { runInNewContext } = require('node:vm');

function endpoint(hub) {
  const module = { exports: {} };
  runInNewContext(
    readFileSync(join(__dirname, '../core/server/api/endpoints/gather-sites.js'), 'utf8'),
    {
      module,
      require(id) {
        assert.equal(id, '../../services/gather-sites');
        return { getHub: () => hub };
      },
    },
  );
  return module.exports;
}

async function browse(hub) {
  const response = {
    headers: {},
    set(name, value) { this.headers[name] = value; },
    status(value) { this.statusCode = value; return this; },
    json(value) { this.body = value; return this; },
  };
  await endpoint(hub).browse({}, response);
  assert.equal(response.headers['Cache-Control'], 'no-store');
  return response;
}

test('site API returns known authentication failures without exposing unexpected infrastructure errors', async () => {
  for (const error of [
    { statusCode: 401, message: 'frontro_session_expired' },
    { statusCode: 403, code: 'site_access_revoked' },
  ]) {
    const response = await browse({ async browse() { throw error; } });
    assert.equal(response.statusCode, error.statusCode);
    assert.equal(response.body.code, error.code || error.message);
  }
  for (const error of [
    { statusCode: 503, message: 'Private provider cookie and database details' },
    { statusCode: 403, code: 'private_credentials', message: 'Secret' },
    { statusCode: 500, code: 'site_not_found' },
    { statusCode: 503, code: '__proto__' },
    null,
  ]) {
    const response = await browse({ async browse() { throw error; } });
    assert.equal(response.statusCode, 503);
    assert.equal(JSON.stringify(response.body), '{"code":"site_management_unavailable"}');
  }
});

test('a disabled site API never invokes a publication handler', async () => {
  const response = await browse(undefined);
  assert.equal(response.statusCode, 404);
  assert.equal(JSON.stringify(response.body), '{"code":"site_management_unavailable"}');
});
