const util = require('util');
const session = require('express-session');
const config = require('../../../../shared/config');
const settingsCache = require('../../../../shared/settings-cache');
const models = require('../../../models');
const urlUtils = require('../../../../shared/url-utils').default;

const SessionStore = require('./session-store');
const sessionStore = new SessionStore(models.Session);

let unoExpressSessionMiddleware;

function getExpressSessionMiddleware() {
  if (!unoExpressSessionMiddleware) {
    unoExpressSessionMiddleware = session({
      store: sessionStore,
      secret: settingsCache.get('admin_session_secret'),
      resave: false,
      saveUninitialized: false,
      name: config.get('gather:tenant:siteId') ? '__Host-gather-admin-session' : 'ghost-admin-api-session',
      cookie: {
        maxAge: config.get('admin:sessionMaxAgeMs'),
        httpOnly: true,
        path: config.get('gather:tenant:siteId') ? '/' : urlUtils.getSubdir() + '/ghost',
        sameSite: config.get('gather:tenant:siteId') ? 'lax' : urlUtils.isSSL(config.get('url')) ? 'none' : 'lax',
        secure: urlUtils.isSSL(config.get('url')),
      },
    });
  }
  return unoExpressSessionMiddleware;
}

module.exports.getSession = async function getSession(req, res) {
  if (req.session) {
    return req.session;
  }
  const expressSessionMiddleware = getExpressSessionMiddleware();
  return new Promise((resolve, reject) => {
    expressSessionMiddleware(req, res, function (err) {
      if (err) {
        return reject(err);
      }
      resolve(req.session);
    });
  });
};

module.exports.deleteAllSessions = util.promisify(sessionStore.clear.bind(sessionStore));
