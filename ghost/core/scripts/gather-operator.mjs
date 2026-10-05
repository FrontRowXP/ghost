// Offline rollout command. Private configuration and backup attestation are
// projected by the operator; no privileged DDL is exposed through an API.
import {readFile, stat} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {createHash} from 'node:crypto';
import {pipeline} from 'node:stream/promises';
import {createRequire} from 'node:module';
const require = createRequire(import.meta.url);
const args = Object.fromEntries(process.argv.slice(2).reduce((items, value, index, all) => {if (value.startsWith('--')) items.push([value.slice(2), all[index + 1]]); return items;}, []));
if (!['install', 'restore-grants'].includes(args.mode) || !args.config) throw new Error('Choose an explicit offline operator mode and private config file');
if ((await stat(args.config)).mode & 0o077) throw new Error('Operator configuration must be private');
const input = JSON.parse(await readFile(args.config, 'utf8'));
const config = require('../core/shared/config');
const {installTenantIsolation, restoreTenantPrivileges, tenantRole} = require('../core/server/lib/gather/database');
const {deriveTenantCredential} = await import('./gather-worker-config.mjs');
const {SiteRegistry} = require('../core/server/lib/gather/registry');
if (input.operatorDatabase?.client !== 'pg' || !/^[a-z_][a-z0-9_]{0,62}$/.test(input.controlRole || '') || input.controlRole.startsWith('gather_site_') || !/^[a-f0-9]{64}$/.test(input.controlPassword || '') || !/^[a-f0-9]{64}$/.test(input.runtimeMasterKey || '')) throw new Error('Invalid private operator identity projection');
config.set('database', input.operatorDatabase);
const database = require('knex')({...input.operatorDatabase, pool: {min: 0, max: 1}});
try {
  const peers = await database.raw('SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND backend_type=\'client backend\'');
  if (peers.rows.length) throw new Error('Stop all application connections before the offline tenancy rollout');
  if (args.mode === 'install') {
    const attestation = JSON.parse(await readFile(input.backupAttestationPath, 'utf8'));
    if (!/^[a-f0-9]{64}$/.test(attestation.sha256 || '') || Date.now() - Date.parse(attestation.verifiedAt) < 0 || Date.now() - Date.parse(attestation.verifiedAt) > 86400000 || !Number.isFinite(Date.parse(attestation.verifiedAt)) || attestation.database !== input.operatorDatabase.connection.database) throw new Error('A recent verified encrypted backup is required');
    const hash = createHash('sha256'); await pipeline(createReadStream(attestation.file), hash);
    if (hash.digest('hex') !== attestation.sha256) throw new Error('The retained encrypted backup differs from its NAS attestation');
    const enrollment = input.enrollment;
    const auth = config.get('security:frontroAuth');
    if (!enrollment || auth?.enabled !== true || auth.staff?.[enrollment.subjectId] !== enrollment.staffId || !['https://moments.frontro.com', 'https://api.moments.frontro.com'].includes(auth.apiOrigin)) throw new Error('Existing owner enrollment must match its previously verified Moments binding');
    let principal;
    for (const session of await database('sessions').where({user_id: enrollment.staffId}).orderBy('updated_at', 'desc').limit(20)) {
      let delegation; try {delegation = JSON.parse(session.session_data).frontroSession;} catch {continue;}
      if (delegation?.subject !== enrollment.subjectId || !/^__Host-moments_session=[a-f0-9]{64}$/.test(delegation.cookie || '')) continue;
      const response = await fetch(auth.apiOrigin + '/v1/me', {headers: {Origin: new URL(config.get('url')).origin, Cookie: delegation.cookie}, redirect: 'error', signal: AbortSignal.timeout(8000)});
      if (response.status !== 200) continue;
      if (Number(response.headers.get('content-length') || 0) > 65536) throw new Error('Owner identity response exceeds its bound');
      const body = await response.text(); if (body.length > 65536) throw new Error('Owner identity response exceeds its bound');
      const candidate = JSON.parse(body);
      if (candidate.user?.id === enrollment.subjectId && candidate.workspaces?.some(workspace => workspace.id === enrollment.workspaceId && workspace.role === 'owner')) {principal = candidate; break;}
    }
    if (!principal) throw new Error('The existing bound owner needs a current Moments session and owned workspace');
    await new (require('../core/server/data/db/database-state-manager'))({knexMigratorFilePath: config.get('paths:appRoot')}).makeReady();
    const existing = await database.raw('SELECT 1 FROM pg_roles WHERE rolname=?', [input.controlRole]);
    if (!existing.rows.length) await database.raw(`CREATE ROLE ?? LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${input.controlPassword}'`, [input.controlRole]);
    await new SiteRegistry(database).registerExistingSite(enrollment);
    await installTenantIsolation(database, enrollment.siteId, input.controlRole);
  } else {
    await restoreTenantPrivileges(database, input.controlRole);
  }
  // Existing cluster roles must authenticate with the projected private password;
  // never silently rotate a role that may belong to another environment.
  const control = require('knex')({...input.operatorDatabase, connection: {...input.operatorDatabase.connection, user: input.controlRole, password: input.controlPassword}, pool: {min: 0, max: 1}, acquireConnectionTimeout: 8000});
  try {
    const identity = await control.raw('SELECT current_user AS role');
    if (identity.rows[0]?.role !== input.controlRole) throw new Error('Projected control identity does not authenticate');
  } finally {await control.destroy();}
  for (const site of await database('gather_sites').whereIn('status', ['active', 'provisioning'])) {
    tenantRole(site.id);
    await database.raw('SELECT gather_ensure_runtime_role(?, ?)', [site.id, deriveTenantCredential(input.runtimeMasterKey, site.id)]);
  }
  console.log(JSON.stringify({event: 'gather_offline_tenancy_operator_complete', mode: args.mode}));
} finally {
  await database.destroy();
  await require('../core/server/data/db').knex.destroy();
}
