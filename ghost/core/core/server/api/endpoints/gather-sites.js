const {getHub} = require('../../services/gather-sites');

function handler(method) {
    return async function gatherSiteHandler(req, res) {
        res.set('Cache-Control', 'no-store');
        const hub = getHub();
        if (!hub) return res.status(404).json({code: 'site_management_unavailable'});
        try { await hub[method](req, res); }
        catch (error) {
            // Never serialize provider responses, cookies, database details or
            // other sites' records. Infrastructure errors remain generic.
            const code = error.statusCode ? error.code || error.message : 'site_management_unavailable';
            const status = [400, 401, 403, 404, 409, 429, 503].includes(error.statusCode) ? error.statusCode : 503;
            res.status(status).json({code});
        }
    };
}

// Like session endpoints, these handlers own a separate authentication store;
// no Ghost staff session is created for a newly signed-up workspace account.
module.exports = {docName: 'gather_sites', browse: handler('browse'), add: handler('create'),
    readSession: handler('session'), start: handler('start'), complete: handler('complete'), logout: handler('logout')};
