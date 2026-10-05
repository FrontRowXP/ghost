// Extends the existing CommonJS auth composition boundary. Browser credentials
// stay at Moments; only its one-use handoff is exchanged by this server.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN = /^[0-9a-f]{64}$/i;
const { randomBytes } = require('node:crypto');
const BINDING_COOKIE = '__Secure-frontro-handoff';

function failure(statusCode, code) {
  const error = new Error(code);
  error.statusCode = statusCode;
  return error;
}

function publicConfiguration(config) {
  if (!config?.enabled) return null;
  const url = new URL(config.apiOrigin);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw failure(503, 'frontro_auth_unavailable');
  }
  return { apiOrigin: url.origin };
}

function readCookie(headers, name) {
  const values = headers.getSetCookie();
  const cookie = values.find(value => value.startsWith(name + '='));
  const pair = cookie?.split(';', 1)[0];
  if (!pair || !TOKEN.test(pair.slice(name.length + 1))) {
    throw failure(503, 'frontro_auth_unavailable');
  }
  return pair;
}

module.exports.publicConfiguration = publicConfiguration;
module.exports.createFrontroAuth = function createFrontroAuth({
  getConfig, getAdminOrigin, getAdminPath = () => '/ghost', findUserById, createSession,
  fetch: request = globalThis.fetch, now = Date.now,
}) {
  // Gather Core is a singleton. A restart intentionally expires pending login
  // attempts; authenticated sessions continue in Ghost's persistent store.
  const handoffs = new Map();
  const cookieOptions = () => ({ secure: true, httpOnly: true, sameSite: 'lax', path: getAdminPath() });
  function binding(req) {
    const cookies = (req.get('cookie') || '').split(';').map(value => value.trim())
      .filter(value => value.startsWith(BINDING_COOKIE + '='));
    const value = cookies.length === 1 ? cookies[0].slice(BINDING_COOKIE.length + 1) : '';
    return TOKEN.test(value) ? value : null;
  }
  function discard(req, res) {
    handoffs.delete(binding(req));
    res.clearCookie(BINDING_COOKIE, cookieOptions());
  }
  function configuration() {
    const config = getConfig();
    const publicConfig = publicConfiguration(config);
    if (!publicConfig) throw failure(404, 'frontro_auth_disabled');
    return { ...config, ...publicConfig };
  }

  function sameOrigin(req) {
    if (req.get('origin') !== getAdminOrigin()) throw failure(403, 'frontro_origin_denied');
  }

  async function call(path, { cookie, body, csrf } = {}) {
    const config = configuration();
    let response;
    try {
      response = await request(config.apiOrigin + '/v1' + path, {
        method: body === undefined ? 'GET' : 'POST',
        redirect: 'error', signal: AbortSignal.timeout(8000),
        headers: {
          Origin: getAdminOrigin(),
          ...(cookie ? { Cookie: cookie } : {}),
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(csrf ? { 'X-CSRF-Token': csrf } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw failure(503, 'frontro_auth_unavailable');
    }
    if (!response.ok) {
      // Do not expose provider responses, cookies or handoff secrets in errors.
      throw failure(response.status === 401 ? 401 : response.status === 429 ? 429 : 503,
        response.status === 401 ? 'frontro_session_expired' : 'frontro_auth_unavailable');
    }
    let data = null;
    if (response.status !== 204) {
      try {
        let size = 0;
        const chunks = [];
        for await (const chunk of response.body) {
          size += chunk.length;
          if (size > 16384) throw new Error('Response too large');
          chunks.push(chunk);
        }
        data = JSON.parse(Buffer.concat(chunks).toString());
      } catch {
        throw failure(503, 'frontro_auth_unavailable');
      }
    }
    return { data, headers: response.headers };
  }

  async function start(req, res) {
    sameOrigin(req);
    for (const [key, value] of handoffs) {
      if (value.expiresAt <= now()) handoffs.delete(key);
    }
    handoffs.delete(binding(req));
    if (handoffs.size >= 1000) throw failure(429, 'frontro_auth_busy');
    const token = randomBytes(32).toString('hex');
    // Reserve before awaiting the provider so concurrent starts stay bounded.
    handoffs.set(token, { expiresAt: now() + 600000 });
    let result;
    try { result = await call('/auth/handoffs', { body: {} }); }
    catch (error) { handoffs.delete(token); throw error; }
    const { data, headers } = result;
    if (!UUID.test(data?.id) || !TOKEN.test(data?.secret) || !/^[A-Z0-9_-]{8}$/.test(data?.code) || data?.expiresIn !== 600) {
      handoffs.delete(token);
      throw failure(503, 'frontro_auth_unavailable');
    }
    try {
      handoffs.set(token, {
        id: data.id, secret: data.secret, cookie: readCookie(headers, '__Host-moments_flow'),
        expiresAt: now() + 600000,
      });
      res.cookie(BINDING_COOKIE, token, { ...cookieOptions(), maxAge: 600000 });
    } catch (error) { handoffs.delete(token); throw error; }
    res.set('Cache-Control', 'no-store');
    res.json({ id: data.id, code: data.code });
  }

  async function complete(req, res) {
    sameOrigin(req);
    const handoff = handoffs.get(binding(req));
    // Consume our browser binding before the upstream exchange, including on
    // failure. Retrying a lost response requires a fresh handoff, never a grant.
    discard(req, res);
    if (!handoff?.id || handoff.expiresAt <= now()) throw failure(401, 'frontro_handoff_expired');
    const { data, headers } = await call('/auth/handoffs/' + handoff.id + '/exchange', {
      cookie: handoff.cookie, body: { secret: handoff.secret },
    });
    if (data?.authenticated !== true) throw failure(401, 'frontro_handoff_pending');
    const cookie = readCookie(headers, '__Host-moments_session');
    const { data: identity } = await call('/me', { cookie });
    const subject = identity?.user?.id;
    const config = configuration();
    const staffId = UUID.test(subject) && Object.hasOwn(config.staff || {}, subject) ? config.staff[subject] : null;
    const user = staffId && await findUserById(staffId);
    if (!user || user.get('status') !== 'active') {
      await revoke({ cookie, csrf: identity?.user?.csrfToken });
      throw failure(403, 'frontro_staff_access_required');
    }
    try {
      // Ghost's own session service rotates the pre-login session identifier.
      await createSession(req, res, user);
      req.session.frontroSession = { cookie, subject, csrf: identity.user.csrfToken };
      await new Promise((resolve, reject) => req.session.save(error => error ? reject(error) : resolve()));
    } catch (error) {
      await revoke({ cookie, csrf: identity?.user?.csrfToken });
      throw error;
    }
    res.set('Cache-Control', 'no-store');
    res.json({ authenticated: true });
  }

  async function validate(session) {
    const stored = session.frontroSession;
    if (!stored) return true;
    if (!getConfig()?.enabled) return false;
    const config = configuration();
    if (!Object.hasOwn(config.staff || {}, stored.subject) || config.staff[stored.subject] !== session.user_id) return false;
    try {
      const { data } = await call('/me', { cookie: stored.cookie });
      return data?.user?.id === stored.subject;
    } catch (error) {
      if (error.statusCode === 401) return false;
      throw error; // Provider outage fails closed without destroying the session.
    }
  }

  async function revoke(stored) {
    if (!stored?.cookie || !stored.csrf) return;
    try { await call('/auth/logout', { cookie: stored.cookie, csrf: stored.csrf, body: {} }); }
    catch { /* Always permit local logout even if Moments is unavailable. */ }
  }

  return { start, complete, validate, revoke, discard };
};
