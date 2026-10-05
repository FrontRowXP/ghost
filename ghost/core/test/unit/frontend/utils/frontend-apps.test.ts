import assert from 'node:assert/strict';
import {
  getFrontendAppConfig,
  getDataAttributes,
  // @ts-expect-error This module lacks type definitions.
} from '../../../../core/frontend/utils/frontend-apps';
// @ts-expect-error This module lacks type definitions.
import configUtils from '../../../utils/config-utils';

describe('Frontend apps:', function () {
  describe('getFrontendAppConfig', function () {
    beforeAll(function () {
      configUtils.set({ 'portal:url': 'https://cdn.example.com/~{version}/portal.min.js' });
      configUtils.set({ 'portal:version': '1.0' });
      configUtils.set({ 'portal:styles': 'https://cdn.example.com/~{version}/main.css' });
    });

    afterAll(async function () {
      await configUtils.restore();
    });

    it('should return app urls and version from config', async function () {
      const { stylesUrl, scriptUrl, appVersion } = getFrontendAppConfig('portal');
      assert.equal(appVersion, '1.0');
      assert.equal(stylesUrl, 'https://cdn.example.com/~1.0/main.css');
      assert.equal(scriptUrl, 'https://cdn.example.com/~1.0/portal.min.js');
    });
  });

  describe('Frontro bundled public apps', function () {
    afterEach(async function () {
      await configUtils.restore();
    });

    it('serves the branded Portal from the site including a configured subdirectory', function () {
      configUtils.set({'security:frontroAuth:enabled': true, url: 'https://gather.example/blog/', 'portal:url': 'https://cdn.jsdelivr.net/ghost/portal@~2.71/umd/portal.min.js'});
      assert.equal(getFrontendAppConfig('portal').scriptUrl, 'https://gather.example/blog/public/gather-portal/portal.min.js');
    });

    it('serves the branded staff toolbar from the same site', function () {
      configUtils.set({'security:frontroAuth:enabled': true, url: 'https://gather.example', 'adminToolbar:url': 'https://cdn.jsdelivr.net/ghost/admin-toolbar@~1.0/umd/admin-toolbar.min.js'});
      assert.equal(getFrontendAppConfig('adminToolbar').scriptUrl, 'https://gather.example/public/gather-toolbar/admin-toolbar.min.js');
    });

    it('preserves an explicitly configured external Portal integration', function () {
      configUtils.set({'security:frontroAuth:enabled': true, 'portal:url': 'https://cdn.example/custom/portal.js'});
      assert.equal(getFrontendAppConfig('portal').scriptUrl, 'https://cdn.example/custom/portal.js');
    });

    it('preserves the upstream URL on older backends without Frontro auth', function () {
      configUtils.set({'security:frontroAuth:enabled': false, 'portal:url': 'https://cdn.jsdelivr.net/ghost/portal@~2.71/umd/portal.min.js'});
      assert.equal(getFrontendAppConfig('portal').scriptUrl, 'https://cdn.jsdelivr.net/ghost/portal@~2.71/umd/portal.min.js');
    });
  });

  describe('getDataAttributes', function () {
    it('should generate data attributes string from object', async function () {
      const dataAttributes = getDataAttributes({
        admin: 'test',
        'example-version': '1.0',
      });

      assert.equal(dataAttributes, 'data-admin="test" data-example-version="1.0"');
    });

    it('should generate empty string for missing data object', async function () {
      const dataAttributes = getDataAttributes();

      assert.equal(dataAttributes, '');
    });
  });
});
