import {test} from 'node:test';
import assert from 'node:assert/strict';
import {safeBackupKey} from './backup-boundary.mjs';
test('encrypted operator snapshots retain both legacy and tenant content without path escapes', () => {
  const site = '12345678-1234-1234-1234-123456789abc';
  for (const key of ['content/images/2026/post.png', 'sites/' + site + '/content/settings/routes.yaml']) assert.equal(safeBackupKey(key), true);
  for (const key of ['secrets/config.json', 'content/../database.dump', 'content//bad', 'sites/other/content/images/x', 'sites/' + site + '/private/x', 'content/images/..\\secret']) assert.equal(safeBackupKey(key), false);
});
