const { config } = require('../services/proxy');

function getFrontendAppConfig(app) {
  const appVersion = config.get(`${app}:version`);
  let scriptUrl = config.get(`${app}:url`);
  let stylesUrl = config.get(`${app}:styles`);
  if (typeof scriptUrl === 'string' && scriptUrl.includes('{version}')) {
    scriptUrl = scriptUrl.replace('{version}', appVersion);
  }
  if (typeof stylesUrl === 'string' && stylesUrl?.includes('{version}')) {
    stylesUrl = stylesUrl.replace('{version}', appVersion);
  }
  // Gather ships its own branded public apps; keep custom integrations and older
  // backends on their configured URL unless Frontro staff auth is enabled.
  const bundled = {
    portal: {prefix: 'https://cdn.jsdelivr.net/ghost/portal@', path: 'gather-portal/portal.min.js'},
    adminToolbar: {prefix: 'https://cdn.jsdelivr.net/ghost/admin-toolbar@', path: 'gather-toolbar/admin-toolbar.min.js'},
  }[app];
  if (bundled && config.get('security:frontroAuth:enabled') &&
      typeof scriptUrl === 'string' && scriptUrl.startsWith(bundled.prefix)) {
    const siteUrl = config.get('url');
    scriptUrl = new URL(`public/${bundled.path}`, siteUrl.endsWith('/') ? siteUrl : `${siteUrl}/`).href;
  }
  return {
    scriptUrl,
    stylesUrl,
    appVersion,
  };
}

function getDataAttributes(data) {
  let dataAttributes = '';

  if (!data) {
    return dataAttributes;
  }
  Object.entries(data).forEach(([key, value]) => {
    if (value === undefined) {
      return;
    }
    dataAttributes += `data-${key}="${value}" `;
  });

  return dataAttributes.trim();
}

module.exports = { getFrontendAppConfig, getDataAttributes };
