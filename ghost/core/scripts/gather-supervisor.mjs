import {fork} from 'node:child_process';
import {randomBytes, timingSafeEqual} from 'node:crypto';
import {createRequire} from 'node:module';
import {mkdtemp, mkdir, symlink, writeFile, rm, readFile} from 'node:fs/promises';
import {request as httpRequest} from 'node:http';
import {join} from 'node:path';
import {tmpdir, totalmem} from 'node:os';
import {setTimeout as delay} from 'node:timers/promises';
import {deriveTenantCredential, workerConfiguration} from './gather-worker-config.mjs';
import {loopbackRequest} from './gather-http.mjs';

const require = createRequire(import.meta.url);

export function validateRuntimeCapacity(maximumSites, memoryBytes) {
  // Reserve parent/control headroom plus a full RSS budget per 320 MiB heap.
  const required = (256 + maximumSites * 768) * 1024 ** 2;
  if (!Number.isInteger(maximumSites) || maximumSites < 2 || maximumSites > 8 || memoryBytes < required) throw new Error('Configured site capacity exceeds the runtime memory budget');
}

export async function startSupervisor(testOptions = {}) {
  if (Object.keys(testOptions).length && process.env.GATHER_DISPOSABLE_CI !== '1') throw new Error('Supervisor dependency overrides are disposable-CI only');
  const config = require('../core/shared/config');
  const settings = config.get('gather:sharedTenancy');
  const template = config.get();
  const origin = new URL(config.get('url')).origin;
  const originSecret = config.get('security:gatherOriginSecret');
  if (settings?.enabled !== true || !origin.startsWith('https://') || typeof originSecret !== 'string' || originSecret.length < 48 ||
    !/^[a-f0-9]{64}$/.test(settings.runtimeMasterKey || '') || !/^[a-f0-9]{64}$/.test(settings.sessionSealingKey || '') ||
    !Number.isInteger(settings.maximumSites) || settings.maximumSites < 2 || settings.maximumSites > 8 ||
    !settings.redis?.host || settings.controlDatabase?.client !== 'pg' || !['staging', 'production'].includes(settings.environment)) {
    throw new Error('Shared tenancy requires a fully projected, bounded configuration');
  }
  if (template.database?.client !== 'pg' || template.database.connection?.user !== settings.controlDatabase.connection?.user || template.database.connection?.password !== settings.controlDatabase.connection?.password) throw new Error('The supervisor configuration must contain only the constrained control database identity');
  if (settings.hostnameDomain !== new URL(origin).hostname || typeof settings.hostnamePrefix !== 'string' || !/^[a-z0-9-]{0,20}$/.test(settings.hostnamePrefix)) throw new Error('Each tenancy environment requires its own hub DNS zone');
  let availableMemory = totalmem();
  for (const filename of ['/sys/fs/cgroup/memory.max', '/sys/fs/cgroup/memory/memory.limit_in_bytes']) {
    const value = await readFile(filename, 'utf8').catch(() => null);
    if (value && /^\d+$/.test(value.trim())) availableMemory = Math.min(availableMemory, Number(value.trim()));
  }
  validateRuntimeCapacity(settings.maximumSites, availableMemory);
  const {SiteRegistry, SitesError, canonicalHostname} = require('../core/server/lib/gather/registry');
  const {TENANT_MANIFEST_HASH} = require('../core/server/lib/gather/database');
  const {SealedRedisStore} = require('../core/server/lib/gather/redis-store');
  const {createSiteHub} = require('../core/server/services/gather-sites/hub');
  const {createStaffLogin} = require('../core/server/lib/gather/staff-login');
  const database = require('knex')({...settings.controlDatabase, connection: {...settings.controlDatabase.connection, statement_timeout: 10000}, pool: {min: 0, max: 4}, acquireConnectionTimeout: 8000});
  const client = require('cache-manager-ioredis').create({...settings.redis, connectTimeout: 5000, maxRetriesPerRequest: 1}).getClient();
  const directory = await mkdtemp(join(tmpdir(), 'gather-tenants-'));
  const workers = new Map();
  const starting = new Map();
  const reservedPorts = new Set();
  const challenges = new Map();
  const retries = new Set();
  let server;
  let stopped = false;
  let stopping;
  let leased = false;
  let leaseTimer;
  const prefix = `gather:{${settings.environment}-sites}`;
  const leaseKey = prefix + ':supervisor';
  const lease = randomBytes(32).toString('hex');
  const logFailure = (event, site) => console.error(JSON.stringify({event, siteId: site?.id || null}));

  function shutdown(leaseLost = false) {
    if (stopping) return stopping;
    stopped = true;
    stopping = (async () => {
      if (leaseLost) clearInterval(leaseTimer);
      for (const timer of retries) clearTimeout(timer);
      retries.clear();
      server?.close();
      const children = [...workers.values()].map(worker => worker.child);
      for (const child of children) child.kill('SIGTERM');
      const deadline = Date.now() + (leaseLost ? 5000 : 20000);
      while (children.some(child => child.exitCode === null && child.signalCode === null) && Date.now() < deadline) await delay(200);
      for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await Promise.allSettled([...starting.values()]);
      clearInterval(leaseTimer);
      if (leased) await client.eval("if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) end return 0", 1, leaseKey, lease).catch(() => {});
      client.disconnect();
      await database.destroy();
      await rm(directory, {recursive: true, force: true});
    })();
    return stopping;
  }
  process.once('SIGTERM', () => {void shutdown();});
  process.once('SIGINT', () => {void shutdown();});
  function retry(callback, milliseconds) {
    if (stopped) return;
    const timer = setTimeout(() => {retries.delete(timer); if (!stopped) callback();}, milliseconds);
    retries.add(timer);
  }
  try {
    const identity = await database.raw('SELECT rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolinherit, rolreplication FROM pg_roles WHERE rolname=current_user');
    if (!identity.rows.length || Object.values(identity.rows[0]).some(Boolean)) throw new Error('Unsafe control database identity');
    const membership = await database.raw('SELECT 1 FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname=current_user)');
    if (membership.rows.length) throw new Error('Control database role membership is forbidden');
    const state = await database('gather_tenancy_state').where({key: 'isolation'}).first();
    if (state?.manifest_hash !== TENANT_MANIFEST_HASH) throw new Error('Audited shared-table isolation is not installed');
    const sites = await database('gather_sites').whereIn('status', ['active', 'provisioning']);
    if (sites.length > settings.maximumSites) throw new Error('Existing sites exceed the bounded process capacity');
    const hostname = slug => canonicalHostname(settings.hostnamePrefix + slug + '.' + settings.hostnameDomain);
    hostname('qualification');
    await client.ping();
    if (await client.set(leaseKey, lease, 'PX', 15000, 'NX') !== 'OK') throw new Error('Another Gather supervisor owns the shared runtime');
    leased = true;
    leaseTimer = setInterval(() => {
      void client.eval("if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('PEXPIRE',KEYS[1],15000) end return 0", 1, leaseKey, lease)
        .then(value => {if (Number(value) !== 1) throw new Error('Lease lost');})
        .catch(() => {logFailure('gather_supervisor_lease_lost'); void shutdown(true);});
    }, 5000);

    async function start(site) {
      if (stopped || starting.has(site.id) || workers.has(site.id)) return starting.get(site.id);
      let allocatedPort;
      const promise = (async () => {
        const domain = await database('gather_site_domains').where({site_id: site.id, is_primary: true}).first();
        if (!domain) throw new Error('A site requires a reserved primary hostname');
        const port = Array.from({length: settings.maximumSites}, (_, i) => 2370 + i).find(value => !reservedPorts.has(value));
        if (!port) throw new Error('Bounded worker capacity exhausted');
        reservedPorts.add(port);
        allocatedPort = port;
        const password = deriveTenantCredential(settings.runtimeMasterKey, site.id);
        const owner = await database('users').where('users.site_id', site.id).join('roles_users', 'roles_users.user_id', 'users.id').join('roles', 'roles.id', 'roles_users.role_id').where('roles.name', 'Owner').select('users.id').first();
        const ownerStaffId = owner?.id || deriveTenantCredential(settings.runtimeMasterKey, site.id, 'owner').slice(0, 24);
        await database.raw('SELECT gather_ensure_runtime_role(?, ?)', [site.id, password]);
        const contentPath = join(directory, site.id, 'content');
        await mkdir(contentPath, {recursive: true, mode: 0o700});
        for (const name of ['data', 'images', 'media', 'files', 'logs', 'settings', 'adapters']) await mkdir(join(contentPath, name), {recursive: true, mode: 0o700});
        await symlink(config.get('paths:contentPath') + '/themes', join(contentPath, 'themes')).catch(error => {if (error.code !== 'EEXIST') throw error;});
        const bridgeSecret = randomBytes(32).toString('hex');
        const workerConfig = workerConfiguration({template, site, hostname: domain.hostname, legacySiteId: state.legacy_site_id, ownerStaffId, password, bridgeSecret, port, contentPath});
        workerConfig.gather.tenant.hubCapability.creationEnabled = settings.creationEnabled === true;
        const filename = join(directory, site.id, 'config.production.json');
        await writeFile(filename, JSON.stringify(workerConfig), {mode: 0o600});
        if (stopped) throw new Error('Supervisor stopped before worker launch');
        const child = fork(join(config.get('paths:appRoot'), 'index.js'), ['site-worker'], {
          cwd: config.get('paths:appRoot'), execArgv: ['--max-old-space-size=320'],
          env: {NODE_ENV: 'production', TZ: 'UTC', GATHER_REQUIRE_POSTGRES: 'true', GATHER_REQUIRE_ORIGIN: 'true', GATHER_SITE_CONFIG: filename},
          stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
        });
        const worker = {child, port, bridgeSecret, ready: false, bootReady: false, hostname: domain.hostname, site};
        child.on('message', message => {if (message?.ready === true) worker.bootReady = true;});
        workers.set(site.id, worker);
        child.once('exit', () => {
          workers.delete(site.id);
          reservedPorts.delete(port);
          retry(() => {
            void database('gather_sites').where({id: site.id}).first().then(current => {
              if (current && ['active', 'provisioning'].includes(current.status)) queue(current);
            }).catch(() => logFailure('gather_tenant_restart_lookup_failed', site));
          }, 5000);
        });
        const deadline = Date.now() + 180000;
        while (!stopped && Date.now() < deadline && child.exitCode === null && child.signalCode === null) {
          try {
            const response = await loopbackRequest(port, '/ghost/api/admin/site/', {headers: {Host: domain.hostname, 'X-Forwarded-Proto': 'https', 'X-Gather-Origin-Key': originSecret}, signal: AbortSignal.timeout(3000)});
            await response.body?.cancel();
            if (response.status === 200 && worker.bootReady) {worker.ready = true; break;}
          } catch { /* Boot remains bounded by the deadline. */ }
          await delay(500);
        }
        if (!worker.ready) {child.kill('SIGTERM'); throw new Error('Tenant worker did not become ready');}
        if (site.status === 'provisioning') {
          const challenge = randomBytes(32).toString('hex');
          challenges.set(domain.hostname, challenge);
          try {
            if (testOptions.verifyDomain) {
              await testOptions.verifyDomain(domain.hostname, challenge);
            } else {
              const response = await fetch('https://' + domain.hostname + '/_gather/domain/' + challenge, {redirect: 'error', signal: AbortSignal.timeout(8000)});
              const body = await response.text();
              if (response.status !== 200 || body !== challenge) throw new Error('Site HTTPS route is not verified');
            }
          } finally {challenges.delete(domain.hostname);}
          if (stopped) throw new Error('Supervisor stopped during provisioning');
          await database.transaction(async tx => {
            await tx('gather_site_staff').insert({id: randomBytes(16).toString('hex'), site_id: site.id, subject_id: site.created_by, staff_id: ownerStaffId}).onConflict(['site_id', 'subject_id']).ignore();
            await tx('gather_site_domains').where({id: domain.id}).update({verified_at: new Date()});
            await tx('gather_sites').where({id: site.id, status: 'provisioning'}).update({status: 'active', updated_at: new Date()});
          });
          site.status = 'active';
        }
      })().catch(async () => {
        if (stopped) return;
        logFailure('gather_tenant_start_failed', site);
        if (site.status === 'provisioning') {
          await database('gather_sites').where({id: site.id, status: 'provisioning'}).update({status: 'failed', updated_at: new Date()});
          workers.get(site.id)?.child.kill('SIGTERM');
        } else retry(() => queue(site), 10000);
      }).finally(() => {
        starting.delete(site.id);
        if (!workers.has(site.id) && allocatedPort) reservedPorts.delete(allocatedPort);
      });
      starting.set(site.id, promise);
      return promise;
    }
    function queue(site) {void start(site);}
    const registry = new SiteRegistry(database, settings.creationEnabled === true ? {maximumSites: settings.maximumSites, hostname, queue} : undefined);
    const store = name => new SealedRedisStore(client, prefix + ':' + name, settings.sessionSealingKey);
    const staffLogin = createStaffLogin({database, registry, flows: store('staff-flows'), grants: store('staff-grants'), hubOrigin: origin});
    const hub = createSiteHub({registry, sessions: store('sessions'), handoffs: store('handoffs'), origin, cookiePath: '/', apiOrigin: config.get('security:frontroAuth:apiOrigin'), staffLogin});
    const app = require('express')();
    app.disable('x-powered-by');
    app.use((req, res, next) => {
      const supplied = Buffer.from(req.get('x-gather-origin-key') || '');
      if (stopped || supplied.length !== Buffer.byteLength(originSecret) || !timingSafeEqual(supplied, Buffer.from(originSecret))) return res.sendStatus(403);
      try {req.gatherHostname = canonicalHostname(req.get('host') || '');} catch {return res.sendStatus(404);}
      res.set('Referrer-Policy', 'no-referrer');
      next();
    });
    const handle = method => async (req, res) => {
      res.set('Cache-Control', 'no-store');
      try {await hub[method](req, res);} catch (error) {
        const permitted = error instanceof SitesError || /^frontro_(auth_unavailable|origin_denied|auth_busy|handoff_expired|handoff_pending|session_expired|identity_required)$/.test(error?.message || '');
        res.status(permitted && [400, 401, 403, 404, 409, 429, 503].includes(error.statusCode) ? error.statusCode : 503).json({code: permitted ? error.code || error.message : 'site_management_unavailable'});
      }
    };
    app.use('/ghost/api/admin/gather', (req, res, next) => req.gatherHostname === new URL(origin).hostname ? next() : res.sendStatus(404), require('express').json({limit: '16kb'}));
    for (const [verb, path, method] of [['get','session','session'], ['get','sites','browse'], ['post','sites','create'], ['post','auth/start','start'], ['post','auth/complete','complete'], ['delete','session','logout'], ['get','auth/site','readStaffLogin'], ['post','auth/site','completeStaffLogin']]) app[verb]('/ghost/api/admin/gather/' + path, handle(method));
    app.use(async (req, res) => {
      const host = req.gatherHostname;
      const challenge = challenges.get(host);
      if (challenge && req.method === 'GET' && req.path === '/_gather/domain/' + challenge) return res.status(200).send(challenge);
      try {
        const site = await registry.resolve(host);
        const worker = workers.get(site.id);
        if (!worker?.ready) return res.sendStatus(503);
        if (req.path === '/ghost/_gather/signin/start/' && req.method === 'GET') return await staffLogin.start(req, res, site.id, host);
        if (req.path === '/ghost/_gather/signin/complete/' && req.method === 'GET') {
          const delegation = await staffLogin.consume(req, host, site.id);
          const response = await loopbackRequest(worker.port, '/ghost/api/admin/authentication/gather/delegation/', {
            method: 'POST', headers: {Host: host, Origin: 'https://' + host, 'X-Forwarded-Proto': 'https', 'X-Gather-Origin-Key': originSecret, 'X-Gather-Worker-Key': worker.bridgeSecret, 'Content-Type': 'application/json'}, body: JSON.stringify(delegation), signal: AbortSignal.timeout(15000), redirect: 'error',
          });
          await response.body?.cancel();
          if (response.status !== 200) return res.status(403).send('Site access is unavailable. Sign in again from your site.');
          const cookies = response.headers.getSetCookie();
          if (cookies.length) res.setHeader('Set-Cookie', cookies);
          res.clearCookie('__Host-gather-site-login', {path: '/', secure: true, httpOnly: true, sameSite: 'lax'});
          return res.redirect('/ghost/#/site');
        }
        const headers = {...req.headers, host, 'x-forwarded-proto': 'https'};
        delete headers['x-gather-worker-key'];
        const upstream = httpRequest({host: '127.0.0.1', port: worker.port, path: req.url, method: req.method, headers}, response => {
          res.writeHead(response.statusCode, response.headers);
          response.pipe(res);
        });
        upstream.setTimeout(120000, () => upstream.destroy());
        upstream.on('error', () => {if (!res.headersSent) res.sendStatus(503); else res.destroy();});
        req.on('aborted', () => upstream.destroy());
        req.pipe(upstream);
      } catch {if (!res.headersSent) res.sendStatus(404); else res.destroy();}
    });
    server = await new Promise((resolve, reject) => {const listener = app.listen(config.get('server:port') || 2368, config.get('server:host') || '0.0.0.0', () => resolve(listener)); listener.once('error', reject);});
    for (const site of sites) await start(site);
    return {shutdown, registry, server};
  } catch (error) {
    await shutdown();
    throw error;
  }
}
