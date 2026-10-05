const {test} = require('node:test');
const assert = require('node:assert/strict');
const {nativeAuthUnavailable} = require('../core/server/lib/gather/native-auth');
test('fixed workers keep readonly setup boot while denying native login and credential replacement, with either route spelling', () => {
  for (const suffix of ['', '/']) {
    for (const [method, path] of [['POST', '/session'], ['POST', '/authentication/setup'], ['PUT', '/authentication/setup'], ['POST', '/authentication/password_reset'], ['PUT', '/authentication/password_reset'], ['POST', '/authentication/invitation'], ['POST', '/authentication/reset']]) assert.equal(nativeAuthUnavailable(method, path + suffix), true);
    assert.equal(nativeAuthUnavailable('GET', '/authentication/setup' + suffix), false);
    assert.equal(nativeAuthUnavailable('DELETE', '/session' + suffix), false);
    assert.equal(nativeAuthUnavailable('POST', '/authentication/gather/delegation' + suffix), false);
  }
});
