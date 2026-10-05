const { getHub } = require('../../services/gather-sites');

const publicErrors = Object.freeze({
  site_management_unavailable: [503],
  invalid_hostname: [400],
  site_not_found: [404],
  site_access_revoked: [403],
  invalid_site_binding: [400],
  existing_owner_required: [403],
  site_binding_conflict: [409],
  domain_in_use: [409],
  staff_binding_conflict: [409],
  workspace_owner_required: [403],
  site_creation_unavailable: [503],
  identity_unavailable: [503],
  site_sessions_busy: [429],
  origin_denied: [403],
  authentication_required: [401],
  csrf_invalid: [403],
  frontro_auth_disabled: [404],
  frontro_auth_unavailable: [503, 429],
  frontro_origin_denied: [403],
  frontro_auth_busy: [429],
  frontro_handoff_expired: [401],
  frontro_handoff_pending: [401],
  frontro_session_expired: [401],
  frontro_identity_required: [401, 403],
});

function handler(method) {
  return async function gatherSiteHandler(req, res) {
    res.set('Cache-Control', 'no-store');
    const hub = getHub();
    if (!hub) {
      return res.status(404).json({ code: 'site_management_unavailable' });
    }
    try {
      await hub[method](req, res);
    } catch (error) {
      // Never serialize provider responses, cookies, database details or
      // other sites' records. Infrastructure errors remain generic.
      const code = error?.code || error?.message;
      if (Object.hasOwn(publicErrors, code) && publicErrors[code].includes(error?.statusCode)) {
        return res.status(error.statusCode).json({ code });
      }
      return res.status(503).json({ code: 'site_management_unavailable' });
    }
  };
}

// Like session endpoints, these handlers own a separate authentication store;
// no Ghost staff session is created for a newly signed-up workspace account.
module.exports = {
  docName: 'gather_sites',
  browse: handler('browse'),
  add: handler('create'),
  readSession: handler('session'),
  start: handler('start'),
  complete: handler('complete'),
  logout: handler('logout'),
};
