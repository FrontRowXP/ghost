const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { runInNewContext } = require('node:vm');
const { publicConfiguration } = require('../core/server/services/auth/frontro-auth');

function serializer(name) {
  const module = { exports: {} };
  // Isolate unrelated logging, translation and user mappers; execute the actual
  // serializer source so its response shape and whitelist remain under test.
  runInNewContext(readFileSync(join(__dirname,
    '../core/server/api/endpoints/utils/serializers/output', name + '.js'), 'utf8'), {
    module,
    require(id) {
      if (id === '@tryghost/debug') return () => () => {};
      if (id === '@tryghost/tpl') return value => value;
      if (id === './mappers') return {};
      if (id === 'lodash') return { pick: (data, keys) => Object.fromEntries(
        keys.filter(key => Object.hasOwn(data, key)).map(key => [key, data[key]])) };
      throw new Error('Unexpected dependency: ' + id);
    },
  });
  return module.exports;
}

test('public site serialization retains only the sanitized Moments capability', () => {
  const privateConfig = { enabled: true, apiOrigin: 'https://moments.frontro.com', staff: { subject: 'owner' } };
  const frame = {};
  serializer('site').read({ title: 'Gather', authReact: true,
    frontroAuth: publicConfiguration(privateConfig), security: privateConfig }, {}, frame);
  assert.equal(frame.response.site.authReact, true);
  assert.equal(JSON.stringify(frame.response.site.frontroAuth), '{"apiOrigin":"https://moments.frontro.com"}');
  assert.equal(frame.response.site.security, undefined);
  assert.equal(JSON.stringify(frame.response).includes('subject'), false);
});

for (const method of ['frontroStart', 'frontroComplete']) {
  test(method + ' preserves the executable HTTP session handler', async () => {
    const frame = {};
    let called = false;
    const handler = async (req, res) => { called = true; res.status = 401; };
    serializer('authentication')[method](handler, {}, frame);
    assert.equal(frame.response, handler);
    const response = {};
    await frame.response({}, response);
    assert.equal(called, true);
    assert.equal(response.status, 401);
  });
}
