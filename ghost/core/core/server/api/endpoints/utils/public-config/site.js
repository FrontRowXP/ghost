const ghostVersion = require('@tryghost/version');
const settingsCache = require('../../../../../shared/settings-cache');
const config = require('../../../../../shared/config');
const urlUtils = require('../../../../../shared/url-utils').default;
const labs = require('../../../../../shared/labs');
const { publicConfiguration } = require('../../../../services/auth/frontro-auth');

module.exports = function getSiteProperties() {
  const siteProperties = {
    title: settingsCache.get('title'),
    description: settingsCache.get('description'),
    logo: settingsCache.get('logo'),
    icon: settingsCache.get('icon'),
    cover_image: settingsCache.get('cover_image'),
    accent_color: settingsCache.get('accent_color'),
    locale: settingsCache.get('locale'),
    timezone: settingsCache.get('timezone'),
    url: urlUtils.urlFor('home', true),
    version: ghostVersion.safe,
    allow_external_signup:
      settingsCache.get('allow_self_signup') &&
      !(
        settingsCache.get('portal_signup_checkbox_required') &&
        settingsCache.get('portal_signup_terms_html')
      ),
    site_uuid: settingsCache.get('site_uuid'),
    // Admin's auth screens render before a session exists, so they can't read /config/ labs
    authReact: labs.isSet('authReact'),
  };

  const frontroAuth = publicConfiguration(config.get('security:frontroAuth'));
  const siteHub = require('../../../../services/gather-sites').getHub();
  if (siteHub) siteProperties.gatherSites = siteHub.capability;
  if (config.get('gather:tenant:siteId')) {
    siteProperties.gatherSites = {...config.get('gather:tenant:hubCapability')};
    if (new URL(config.get('url')).origin !== config.get('gather:tenant:hubOrigin')) siteProperties.gatherSites.hubUrl = config.get('gather:tenant:hubOrigin') + '/ghost/#/sites';
  }
  if (frontroAuth) {
    siteProperties.frontroAuth = frontroAuth;
    if (config.get('gather:tenant:siteId')) siteProperties.frontroAuth.siteSignInUrl = '/ghost/_gather/signin/start/';
    siteProperties.authReact = true;
  }

  if (config.get('client_sentry') && !config.get('client_sentry').disabled) {
    siteProperties.sentry_dsn = config.get('client_sentry').dsn;

    let environment = config.get('PRO_ENV');
    if (!environment) {
      environment = config.get('env');
    }

    siteProperties.sentry_env = environment;
  }

  return siteProperties;
};
