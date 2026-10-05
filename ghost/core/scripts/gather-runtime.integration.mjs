// Real process/database qualification on disposable CI services. The HTTP S3
// fixture and domain-route override are explicitly not NAS/TLS acceptance.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { randomBytes, randomUUID, createHmac } from 'node:crypto';
import { mkdtemp, mkdir, symlink, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { startSupervisor } from './gather-supervisor.mjs';
import { deriveTenantCredential } from './gather-worker-config.mjs';
import { loopbackRequest } from './gather-http.mjs';
const require = createRequire(import.meta.url);
const exec = promisify(execFile);

function s3Fixture() {
  const objects = new Map();
  const server = createServer(async (req, res) => {
    const key = decodeURIComponent(req.url.split('?')[0]).replace(/^\/fixture\//, '');
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    if (req.method === 'PUT') {
      const source = req.headers['x-amz-copy-source'];
      const object = source
        ? objects.get(decodeURIComponent(source).replace(/^\/fixture\//, ''))
        : { body: Buffer.concat(chunks), type: req.headers['content-type'] };
      if (!object) return res.writeHead(404).end('<Error><Code>NoSuchKey</Code></Error>');
      objects.set(key, object);
      if (source)
        return res
          .writeHead(200, { 'Content-Type': 'application/xml' })
          .end('<CopyObjectResult><ETag>"fixture"</ETag></CopyObjectResult>');
      return res.writeHead(200, { ETag: '"fixture"' }).end();
    }
    if (req.method === 'DELETE') {
      objects.delete(key);
      return res.writeHead(204).end();
    }
    const object = objects.get(key);
    if (!object)
      return res
        .writeHead(404, { 'Content-Type': 'application/xml' })
        .end('<Error><Code>NoSuchKey</Code></Error>');
    res.writeHead(200, {
      'Content-Length': object.body.length,
      'Content-Type': object.type || 'application/octet-stream',
      ETag: '"fixture"',
    });
    res.end(req.method === 'HEAD' ? undefined : object.body);
  });
  return { server, objects };
}

test(
  'two actual fixed-role publication processes publish independently and recover without a new database',
  { timeout: 240000 },
  async () => {
    assert.equal(process.env.GATHER_DISPOSABLE_CI, '1');
    const knex = require('knex');
    const config = require('../core/shared/config');
    const namespace = 'gather_runtime_' + randomBytes(6).toString('hex');
    const controlRole = 'gather_control_' + randomBytes(6).toString('hex');
    const controlPassword = randomBytes(32).toString('hex');
    const master = randomBytes(32).toString('hex');
    const ids = [randomUUID(), randomUUID()];
    const subject = randomUUID();
    const workspace = randomUUID();
    const folder = await mkdtemp(join(tmpdir(), 'gather-runtime-ci-'));
    const connection = {
      host: '127.0.0.1',
      port: 5432,
      user: 'gather_test',
      password: 'gather_test',
      database: 'gather_test',
      options: '-c search_path=' + namespace,
    };
    let operator = knex({ client: 'pg', connection, pool: { min: 0, max: 3 } });
    const s3 = s3Fixture();
    let supervisor;
    const runtimes = [];
    const original = new Map(
      [
        'database',
        'url',
        'admin',
        'paths:contentPath',
        'security',
        'storage',
        'adapters',
        'server',
        'gather',
        'sodoSearch',
      ].map((key) => [key, config.get(key)]),
    );
    try {
      await operator.raw('CREATE SCHEMA ??', [namespace]);
      await operator.raw(
        `CREATE ROLE ?? LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${controlPassword}'`,
        [controlRole],
      );
      await mkdir(join(folder, 'content'), { recursive: true });
      await symlink(resolve('content/themes'), join(folder, 'content', 'themes'));
      config.set('database', { client: 'pg', connection });
      config.set('url', 'https://gather.example.test');
      config.set('admin', { url: 'https://gather.example.test' });
      config.set('paths:contentPath', join(folder, 'content'));
      // Global migrations run once as the operator, before forced isolation.
      await new (require('knex-migrator'))({ knexMigratorFilePath: resolve('.') }).init();
      const owner = await operator('users').first();
      assert.ok(owner);
      await operator('users').where({ id: owner.id }).update({ status: 'active' });
      await require('../core/server/models').Settings.populateDefaults();
      await operator('settings').where({ key: 'title' }).update({ value: 'Existing' });
      const { SiteRegistry } = require('../core/server/lib/gather/registry');
      const registry = new SiteRegistry(operator);
      await registry.registerExistingSite({
        siteId: ids[0],
        workspaceId: workspace,
        subjectId: subject,
        staffId: owner.id,
        name: 'Existing',
        hostname: 'gather.example.test',
      });
      await operator('gather_sites').insert({
        id: ids[1],
        workspace_id: workspace,
        created_by: subject,
        name: 'Independent',
        slug: 'independent',
        status: 'provisioning',
        created_at: new Date(),
        updated_at: new Date(),
      });
      await operator('gather_site_domains').insert({
        id: randomUUID(),
        site_id: ids[1],
        hostname: 'independent.gather.example.test',
        is_primary: true,
      });
      const {
        installTenantIsolation,
        verifyTenantDatabase,
        TENANT_TABLES,
        tenantRole,
      } = require('../core/server/lib/gather/database');
      await installTenantIsolation(operator, ids[0], controlRole);
      await new Promise((resolve) => s3.server.listen(0, '127.0.0.1', resolve));
      const endpoint = 'http://127.0.0.1:' + s3.server.address().port;
      const storage = {
        bucket: 'fixture',
        region: 'us-east-1',
        endpoint,
        forcePathStyle: true,
        accessKeyId: 'fixture-access',
        secretAccessKey: 'fixture-secret',
        multipartUploadThresholdBytes: 8 * 1024 * 1024,
        multipartChunkSizeBytes: 5 * 1024 * 1024,
      };
      config.set('security', {
        ...config.get('security'),
        gatherOriginSecret: 'a'.repeat(64),
        frontroAuth: { enabled: true, apiOrigin: 'https://moments.example.test' },
      });
      config.set('storage', {
        active: 'S3Storage',
        S3Storage: {
          ...storage,
          cdnUrl: 'https://gather.example.test/_assets',
          staticFileURLPrefix: 'content/images',
        },
        media: {
          ...storage,
          adapter: 'S3Storage',
          cdnUrl: 'https://gather.example.test/_assets',
          staticFileURLPrefix: 'content/media',
        },
        files: {
          ...storage,
          adapter: 'S3Storage',
          cdnUrl: 'https://gather.example.test/_assets',
          staticFileURLPrefix: 'content/files',
        },
      });
      config.set('adapters', {
        ...config.get('adapters'),
        cache: { active: 'MemoryCache', settings: { adapter: 'MemoryCache' } },
        'route-settings': {
          active: 'S3RouteSettingsStore',
          S3RouteSettingsStore: {
            ...storage,
            staticFileURLPrefix: 'content/settings',
            defaultSettingsBasePath: resolve('core/server/services/route-settings'),
          },
        },
        redirects: {
          active: 'S3RedirectsStore',
          S3RedirectsStore: { ...storage, staticFileURLPrefix: 'content/settings' },
        },
      });
      config.set('server', { host: '127.0.0.1', port: 2368 });
      config.set('gather', {
        sharedTenancy: {
          enabled: true,
          creationEnabled: true,
          environment: 'staging',
          maximumSites: 2,
          hostnamePrefix: '',
          hostnameDomain: 'gather.example.test',
          runtimeMasterKey: master,
          sessionSealingKey: 'b'.repeat(64),
          redis: { host: '127.0.0.1', port: 6379 },
          controlDatabase: {
            client: 'pg',
            connection: { ...connection, user: controlRole, password: controlPassword },
          },
        },
      });
      config.set('database', {
        client: 'pg',
        connection: { ...connection, user: controlRole, password: controlPassword },
      });
      const request = async (host, path, options = {}) =>
        loopbackRequest(2368, path, {
          ...options,
          headers: {
            Host: host,
            Origin: 'https://' + host,
            'X-Gather-Origin-Key': 'a'.repeat(64),
            ...options.headers,
          },
          signal: AbortSignal.timeout(10000),
          redirect: 'manual',
        });
      const start = () =>
        startSupervisor({
          verifyDomain: async (host, challenge) => {
            const response = await request(host, '/_gather/domain/' + challenge);
            assert.equal(response.status, 200);
            assert.equal(await response.text(), challenge);
          },
        });
      supervisor = await start();
      const hosts = ['gather.example.test', 'independent.gather.example.test'];
      const tokens = [];
      for (const [i, id] of ids.entries()) {
        const database = knex({
          client: 'pg',
          connection: {
            ...connection,
            user: tenantRole(id),
            password: deriveTenantCredential(master, id),
          },
          pool: { min: 0, max: 2 },
        });
        runtimes.push(database);
        assert.equal((await operator('gather_sites').where({ id }).first()).status, 'active');
        const site = await (await request(hosts[i], '/ghost/api/admin/site/')).json();
        assert.equal(site.site.title, i ? 'Independent' : 'Existing');
        const key = await database('api_keys')
          .join('integrations', 'integrations.id', 'api_keys.integration_id')
          .where({ 'api_keys.type': 'admin', 'integrations.slug': 'zapier' })
          .select('api_keys.*')
          .first();
        assert.ok(key?.secret);
        const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
        const now = Math.floor(Date.now() / 1000);
        const input =
          encode({ alg: 'HS256', typ: 'JWT', kid: key.id }) +
          '.' +
          encode({ iat: now, exp: now + 600, aud: '/admin/' });
        tokens.push(
          input +
            '.' +
            createHmac('sha256', Buffer.from(key.secret, 'hex')).update(input).digest('base64url'),
        );
      }
      const posts = [];
      for (const [i, host] of hosts.entries()) {
        const response = await request(host, '/ghost/api/admin/posts/?source=html', {
          method: 'POST',
          headers: { Authorization: 'Ghost ' + tokens[i], 'Content-Type': 'application/json' },
          body: JSON.stringify({
            posts: [
              {
                title: i ? 'Second tenant' : 'First tenant',
                slug: 'shared-slug',
                status: 'published',
                html: '<p>Independent publication</p>',
              },
            ],
          }),
        });
        assert.equal(
          response.status,
          201,
          await response.text().then((body) => (response.status === 201 ? '' : body)),
        );
        posts.push(await runtimes[i]('posts').where({ slug: 'shared-slug' }).first());
      }
      assert.notEqual(posts[0].id, posts[1].id);
      assert.equal(
        (
          await request(hosts[0], '/ghost/api/admin/posts/' + posts[1].id + '/', {
            headers: { Authorization: 'Ghost ' + tokens[0] },
          })
        ).status,
        404,
      );
      assert.equal(
        (
          await request(hosts[1], '/ghost/api/admin/posts/', {
            headers: { Authorization: 'Ghost ' + tokens[0] },
          })
        ).status,
        401,
      );
      assert.equal(
        (await request('unregistered.example.test', '/ghost/api/admin/site/')).status,
        404,
      );
      const scheduled = [];
      for (const [i, host] of hosts.entries()) {
        const response = await request(host, '/ghost/api/admin/posts/?source=html', {
          method: 'POST',
          headers: { Authorization: 'Ghost ' + tokens[i], 'Content-Type': 'application/json' },
          body: JSON.stringify({
            posts: [
              {
                title: 'Recovered schedule ' + i,
                slug: 'shared-schedule',
                status: 'scheduled',
                published_at: new Date(Date.now() + 180000).toISOString(),
                html: '<p>Durable schedule</p>',
              },
            ],
          }),
        });
        assert.equal(
          response.status,
          201,
          await response.text().then((body) => (response.status === 201 ? '' : body)),
        );
        scheduled.push(await runtimes[i]('posts').where({ slug: 'shared-schedule' }).first());
        const bytes = Buffer.from('Publication ' + i);
        const form = new FormData();
        form.append('file', new Blob([bytes], { type: 'text/plain' }), 'shared-file.txt');
        const upload = await request(host, '/ghost/api/admin/files/upload/', {
          method: 'POST',
          headers: { Authorization: 'Ghost ' + tokens[i] },
          body: form,
        });
        assert.equal(upload.status, 201);
        const url = new URL((await upload.json()).files[0].url);
        const prefix = i ? 'sites/' + ids[i] + '/' : '';
        assert.equal(url.hostname, host);
        assert.ok(url.pathname.startsWith('/_assets/' + prefix + 'content/files/'));
        assert.deepEqual(s3.objects.get(url.pathname.slice('/_assets/'.length)).body, bytes);
      }
      await supervisor.shutdown();
      for (const post of scheduled)
        await operator('posts')
          .where({ id: post.id })
          .update({ published_at: new Date(Date.now() - 5000) });
      // Actual pg_dump/pg_restore, retaining the shared database and schema.
      // Only this unique disposable CI schema is removed during the rehearsal.
      const counts = await Promise.all(
        TENANT_TABLES.map((table) => operator(table).count('* as count').first()),
      );
      const dump = join(folder, 'restore.dump');
      const pgEnvironment = {
        ...process.env,
        PGHOST: connection.host,
        PGPORT: String(connection.port),
        PGUSER: connection.user,
        PGPASSWORD: connection.password,
        PGDATABASE: connection.database,
      };
      await exec(
        '/usr/lib/postgresql/16/bin/pg_dump',
        [
          '--format=custom',
          '--no-owner',
          '--no-privileges',
          '--schema=' + namespace,
          '--file=' + dump,
        ],
        { env: pgEnvironment, timeout: 60000 },
      );
      await operator.raw('DROP SCHEMA ?? CASCADE', [namespace]);
      await exec(
        '/usr/lib/postgresql/16/bin/pg_restore',
        [
          '--dbname=' + connection.database,
          '--no-owner',
          '--no-privileges',
          '--exit-on-error',
          '--single-transaction',
          dump,
        ],
        { env: pgEnvironment, timeout: 60000 },
      );
      assert.deepEqual(
        await Promise.all(
          TENANT_TABLES.map((table) => operator(table).count('* as count').first()),
        ),
        counts,
      );
      const operatorFile = join(folder, 'operator.json');
      const runtimeFile = join(folder, 'runtime.json');
      await writeFile(
        operatorFile,
        JSON.stringify({
          operatorDatabase: { client: 'pg', connection },
          controlRole,
          controlPassword,
          runtimeMasterKey: master,
        }),
        { mode: 0o600 },
      );
      await writeFile(runtimeFile, JSON.stringify(config.get()), { mode: 0o600 });
      await Promise.all(runtimes.map((runtime) => runtime.destroy()));
      await require('../core/server/data/db').knex.destroy();
      await operator.destroy();
      await exec(
        process.execPath,
        ['scripts/gather-operator.mjs', '--mode', 'restore-grants', '--config', operatorFile],
        { env: { NODE_ENV: 'production', GATHER_SITE_CONFIG: runtimeFile }, timeout: 60000 },
      );
      operator = knex({ client: 'pg', connection, pool: { min: 0, max: 3 } });
      for (const [i, id] of ids.entries())
        runtimes[i] = knex({
          client: 'pg',
          connection: {
            ...connection,
            user: tenantRole(id),
            password: deriveTenantCredential(master, id),
          },
          pool: { min: 0, max: 2 },
        });
      const issuer = knex({
        client: 'pg',
        connection: { ...connection, user: controlRole, password: controlPassword },
      });
      try {
        for (const id of ids)
          await issuer.raw('SELECT gather_ensure_runtime_role(?, ?)', [
            id,
            deriveTenantCredential(master, id),
          ]);
      } finally {
        await issuer.destroy();
      }
      for (const [i, runtime] of runtimes.entries()) {
        await verifyTenantDatabase(runtime, ids[i]);
        await assert.rejects(
          runtime.raw('SELECT gather_ensure_runtime_role(?, ?)', [
            ids[i],
            deriveTenantCredential(master, ids[i]),
          ]),
          /permission denied/,
        );
      }
      supervisor = await start();
      const recoveryDeadline = Date.now() + 20000;
      while (Date.now() < recoveryDeadline) {
        if (
          (
            await Promise.all(
              runtimes.map((runtime, i) => runtime('posts').where({ id: scheduled[i].id }).first()),
            )
          ).every((post) => post.status === 'published')
        )
          break;
        await delay(250);
      }
      for (const [i, runtime] of runtimes.entries())
        assert.equal(
          (await runtime('posts').where({ id: scheduled[i].id }).first()).status,
          'published',
          'The fixed worker must recover its overdue scheduled post',
        );
      for (const [i, host] of hosts.entries()) {
        const response = await request(host, '/ghost/api/admin/posts/' + posts[i].id + '/', {
          headers: { Authorization: 'Ghost ' + tokens[i] },
        });
        assert.equal(response.status, 200);
        assert.equal((await response.json()).posts[0].title, i ? 'Second tenant' : 'First tenant');
      }
      // Delete content from one site; the second site remains publishable.
      const deleted = await request(hosts[0], '/ghost/api/admin/posts/' + posts[0].id + '/', {
        method: 'DELETE',
        headers: { Authorization: 'Ghost ' + tokens[0] },
      });
      assert.equal(deleted.status, 204);
      assert.ok(await runtimes[1]('posts').where({ id: posts[1].id }).first());
    } finally {
      if (supervisor) await supervisor.shutdown();
      s3.server.closeAllConnections();
      if (s3.server.listening) await new Promise((resolve) => s3.server.close(resolve));
      await Promise.all(runtimes.map((database) => database.destroy()));
      await require('../core/server/data/db').knex.destroy();
      await operator.raw('DROP SCHEMA IF EXISTS ?? CASCADE', [namespace]);
      for (const id of ids)
        await operator.raw('DROP ROLE IF EXISTS ??', ['gather_site_' + id.replaceAll('-', '')]);
      await operator.raw('DROP ROLE IF EXISTS ??', [controlRole]);
      await operator.destroy();
      for (const [key, value] of original) config.set(key, value);
      await rm(folder, { recursive: true, force: true });
    }
  },
);
