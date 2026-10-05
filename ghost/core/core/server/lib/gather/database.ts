import errors from '@tryghost/errors';
import { createHash } from 'node:crypto';
import type { Knex } from 'knex';
import tables from './tenant-tables.json';

export const TENANT_TABLES: readonly string[] = Object.freeze(tables);
export const TENANT_MANIFEST_HASH = createHash('sha256').update(JSON.stringify(tables)).digest('hex');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ROLE = /^[a-z_][a-z0-9_]{0,62}$/;
const PLATFORM = ['gather_sites', 'gather_site_domains', 'gather_site_staff', 'gather_tenancy_state'];

export function tenantRole(siteId: string): string {
  if (!UUID.test(siteId)) {
    throw new errors.IncorrectUsageError({ message: 'Invalid tenant identity' });
  }
  return 'gather_site_' + siteId.replaceAll('-', '');
}

function constraintName(kind: string, table: string, columns: string[]): string {
  return `gather_${kind}_${createHash('sha256').update(table + ':' + columns.join(',')).digest('hex').slice(0, 24)}`;
}

// This is an explicit, transactional operator rollout after an encrypted backup,
// not an HTTP operation and not a migration performed by a tenant runtime.
export async function installTenantIsolation(database: Knex, legacySiteId: string, controlRole: string) {
  tenantRole(legacySiteId);
  if (database.client.config.client !== 'pg' || !ROLE.test(controlRole) || controlRole.startsWith('gather_site_')) {
    throw new errors.IncorrectUsageError({ message: 'Invalid tenancy operator configuration' });
  }
  return database.transaction(async (tx) => {
    await tx.raw("SET LOCAL lock_timeout = '5s'");
    await tx.raw("SET LOCAL statement_timeout = '5min'");
    await tx.raw("SELECT pg_advisory_xact_lock(hashtextextended('gather-tenant-isolation', 0))");
    const { rows: [{ schema, owner, version }] } = await tx.raw(
      "SELECT current_schema() AS schema, current_user AS owner, current_setting('server_version_num')::integer AS version",
    );
    if (version < 160000 || owner === controlRole) {
      throw new errors.IncorrectUsageError({ message: 'Tenancy requires PostgreSQL 16 and a separate migration owner' });
    }
    const control = await tx.raw('SELECT rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolinherit, rolreplication FROM pg_roles WHERE rolname = ?', [controlRole]);
    if (!control.rows.length || Object.values(control.rows[0]).some(Boolean)) {
      throw new errors.IncorrectUsageError({ message: 'The control role must not have administrative database privileges' });
    }
    const controlMembership = await tx.raw('SELECT 1 FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname=?)', [controlRole]);
    if (controlMembership.rows.length) {
      throw new errors.IncorrectUsageError({ message: 'The control role must not inherit or assume database roles' });
    }
    const state = await tx('gather_tenancy_state').where({ key: 'isolation' }).first();
    if (state) {
      if (state.manifest_hash !== TENANT_MANIFEST_HASH || state.legacy_site_id !== legacySiteId) {
        throw new errors.IncorrectUsageError({ message: 'Tenancy inventory or legacy site changed; an explicit upgrade is required' });
      }
      return;
    }
    if (!(await tx('gather_sites').where({ id: legacySiteId, status: 'active' }).first())) {
      throw new errors.IncorrectUsageError({ message: 'Register the verified existing publication before isolation rollout' });
    }
    const inventory = await tx.raw("SELECT tablename FROM pg_tables WHERE schemaname = ?", [schema]);
    const allowed = new Set([...tables, ...PLATFORM, 'migrations', 'migrations_lock']);
    if (inventory.rows.some((row: any) => !allowed.has(row.tablename)) || tables.some(name => !inventory.rows.some((row: any) => row.tablename === name))) {
      throw new errors.IncorrectUsageError({ message: 'Publishing table inventory differs from the audited manifest' });
    }
    for (const table of tables) {
      if (!(await tx.schema.hasColumn(table, 'site_id'))) {
        throw new errors.IncorrectUsageError({ message: 'Publishing tenancy column migration is missing' });
      }
      if (await tx(table).whereNotNull('site_id').whereNot('site_id', legacySiteId).first()) {
        throw new errors.IncorrectUsageError({ message: 'Existing rows belong to another site; refusing to reassign them' });
      }
      await tx(table).whereNull('site_id').update({ site_id: legacySiteId });
    }
    await tx.raw(`CREATE FUNCTION ??.gather_current_site() RETURNS text LANGUAGE sql STABLE
      SET search_path = pg_catalog AS $body$
      SELECT CASE WHEN session_user::text ~ '^gather_site_[0-9a-f]{32}$' THEN
        regexp_replace(substring(session_user::text FROM 13),
          '^(.{8})(.{4})(.{4})(.{4})(.{12})$', '\\1-\\2-\\3-\\4-\\5') ELSE NULL END
      $body$`, [schema]);
    // Capture real foreign keys before dropping global semantic uniqueness.
    const foreign = await tx.raw(`SELECT c.conname, source.relname AS source, target.relname AS target,
      c.confdeltype AS deletion, c.condeferrable AS deferred, c.condeferred AS initially_deferred,
      ARRAY(SELECT a.attname FROM unnest(c.conkey) WITH ORDINALITY k(num,ord)
        JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.num ORDER BY k.ord) AS columns,
      ARRAY(SELECT a.attname FROM unnest(c.confkey) WITH ORDINALITY k(num,ord)
        JOIN pg_attribute a ON a.attrelid=c.confrelid AND a.attnum=k.num ORDER BY k.ord) AS target_columns
      FROM pg_constraint c JOIN pg_class source ON source.oid=c.conrelid
      JOIN pg_class target ON target.oid=c.confrelid JOIN pg_namespace n ON n.oid=source.relnamespace
      WHERE c.contype='f' AND n.nspname=?`, [schema]);
    const references = foreign.rows.filter((row: any) => tables.includes(row.target));
    for (const reference of references) {
      if (!tables.includes(reference.source) && reference.source !== 'gather_site_staff') {
        throw new errors.IncorrectUsageError({ message: 'An unaudited table references publication data' });
      }
      await tx.raw('ALTER TABLE ??.?? DROP CONSTRAINT ??', [schema, reference.source, reference.conname]);
    }
    const unique = await tx.raw(`SELECT t.relname AS table, i.relname AS name, con.conname, idx.indexprs, idx.indpred,
      ARRAY(SELECT a.attname FROM unnest(idx.indkey) WITH ORDINALITY k(num,ord)
        JOIN pg_attribute a ON a.attrelid=idx.indrelid AND a.attnum=k.num ORDER BY k.ord) AS columns
      FROM pg_index idx JOIN pg_class t ON t.oid=idx.indrelid JOIN pg_class i ON i.oid=idx.indexrelid
      JOIN pg_namespace n ON n.oid=t.relnamespace LEFT JOIN pg_constraint con ON con.conindid=idx.indexrelid
      WHERE n.nspname=? AND idx.indisunique AND NOT idx.indisprimary`, [schema]);
    for (const index of unique.rows.filter((row: any) => tables.includes(row.table))) {
      if (index.indexprs || index.indpred || !index.columns.length || index.columns.some((column: any) => !column)) {
        throw new errors.IncorrectUsageError({ message: 'An expression unique index requires explicit tenancy review' });
      }
      if (index.conname) {
        await tx.raw('ALTER TABLE ??.?? DROP CONSTRAINT ??', [schema, index.table, index.conname]);
      } else {
        await tx.raw('DROP INDEX ??.??', [schema, index.name]);
      }
      await tx.schema.withSchema(schema).alterTable(index.table, (builder) => {
        builder.unique(['site_id', ...index.columns], { indexName: constraintName('unique', index.table, index.columns) });
      });
    }
    for (const table of tables) {
      const primary = await tx.raw(`SELECT a.attname FROM pg_index i JOIN pg_class c ON c.oid=i.indrelid
        JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum=ANY(i.indkey)
        WHERE n.nspname=? AND c.relname=? AND i.indisprimary ORDER BY a.attnum`, [schema, table]);
      const columns = primary.rows.map((row: any) => row.attname);
      if (columns.length !== 1 && !(table === 'automation_trigger_tiers' && columns.length === 0) && !(table === 'automation_action_edges' && columns.length === 2)) {
        throw new errors.IncorrectUsageError({ message: 'Publication primary-key inventory changed' });
      }
      if (columns.length) {
        await tx.schema.withSchema(schema).alterTable(table, builder => {
          builder.unique(['site_id', ...columns], { indexName: constraintName('primary', table, columns) });
        });
      }
      await tx.raw('ALTER TABLE ??.?? ALTER COLUMN site_id SET NOT NULL', [schema, table]);
      await tx.raw('ALTER TABLE ??.?? ALTER COLUMN site_id SET DEFAULT ??.gather_current_site()', [schema, table, schema]);
      await tx.raw('ALTER TABLE ??.?? ENABLE ROW LEVEL SECURITY', [schema, table]);
      await tx.raw('ALTER TABLE ??.?? FORCE ROW LEVEL SECURITY', [schema, table]);
      await tx.raw('CREATE POLICY gather_tenant ON ??.?? USING (site_id = ??.gather_current_site()) WITH CHECK (site_id = ??.gather_current_site())', [schema, table, schema, schema]);
      await tx.raw('CREATE POLICY gather_maintenance ON ??.?? TO ?? USING (true) WITH CHECK (true)', [schema, table, owner]);
      if (['users', 'roles', 'roles_users'].includes(table)) {
        await tx.raw('CREATE POLICY gather_control_roster ON ??.?? FOR SELECT TO ?? USING (true)', [schema, table, controlRole]);
        await tx.raw('GRANT SELECT ON ??.?? TO ??', [schema, table, controlRole]);
      }
    }
    for (const reference of references) {
      const columns = reference.columns;
      const targets = reference.target_columns;
      const list = (values: string[]) => values.map(() => '??').join(',');
      const action = ({ a: 'NO ACTION', r: 'RESTRICT', c: 'CASCADE', n: 'SET NULL', d: 'SET DEFAULT' } as Record<string, string>)[reference.deletion];
      const suffix = reference.deletion === 'n' || reference.deletion === 'd' ? ` (${list(columns)})` : '';
      await tx.raw(`ALTER TABLE ??.?? ADD CONSTRAINT ?? FOREIGN KEY (${list(['site_id', ...columns])})
        REFERENCES ??.?? (${list(['site_id', ...targets])}) ON DELETE ${action}${suffix}
        ${reference.deferred ? 'DEFERRABLE ' + (reference.initially_deferred ? 'INITIALLY DEFERRED' : 'INITIALLY IMMEDIATE') : ''}`,
      [schema, reference.source, constraintName('foreign', reference.source, columns), 'site_id', ...columns,
        schema, reference.target, 'site_id', ...targets, ...(suffix ? columns : [])]);
    }
    // These legacy relations lacked foreign keys. Preserve historic dangling
    // audit references, but enforce every new write and reject cross-site joins.
    const extra: Array<[string, string, string]> = [
      ['roles_users', 'user_id', 'users'], ['roles_users', 'role_id', 'roles'],
      ['permissions_users', 'user_id', 'users'], ['permissions_users', 'permission_id', 'permissions'],
      ['permissions_roles', 'role_id', 'roles'], ['permissions_roles', 'permission_id', 'permissions'],
      ['invites', 'role_id', 'roles'], ['sessions', 'user_id', 'users'],
      ['api_keys', 'role_id', 'roles'], ['api_keys', 'user_id', 'users'], ['api_keys', 'integration_id', 'integrations'],
      ['posts', 'published_by', 'users'], ['mobiledoc_revisions', 'post_id', 'posts'],
      ['post_revisions', 'post_id', 'posts'], ['emails', 'post_id', 'posts'],
      ['email_recipients', 'member_id', 'members'], ['email_recipient_failures', 'member_id', 'members'],
      ['automated_email_recipients', 'member_id', 'members'],
    ];
    for (const [source, column, target] of extra) {
      if (references.some((reference: any) => reference.source === source && reference.columns.length === 1 && reference.columns[0] === column)) {
        continue;
      }
      await tx.raw('ALTER TABLE ??.?? ADD CONSTRAINT ?? FOREIGN KEY (site_id, ??) REFERENCES ??.?? (site_id, id) NOT VALID',
        [schema, source, constraintName('foreign', source, [column]), column, schema, target]);
    }
    const views = await tx.raw('SELECT viewname FROM pg_views WHERE schemaname = ?', [schema]);
    for (const view of views.rows) {
      if (view.viewname !== 'members_resolved_subscription') {
        throw new errors.IncorrectUsageError({ message: 'Publication view inventory changed' });
      }
      await tx.raw('ALTER VIEW ??.?? SET (security_invoker = true)', [schema, view.viewname]);
    }
    for (const table of PLATFORM) {
      await tx.raw('REVOKE ALL ON ??.?? FROM PUBLIC', [schema, table]);
      await tx.raw('GRANT SELECT, INSERT, UPDATE, DELETE ON ??.?? TO ??', [schema, table, controlRole]);
    }
    await tx.raw('GRANT USAGE ON SCHEMA ?? TO ??', [schema, controlRole]);
    // Only this constrained function can create runtime identities. Control has
    // no CREATE ROLE, database ownership, RLS bypass, or publication write grant.
    const schemaLiteral = schema.replaceAll("'", "''");
    const tableLiteral = JSON.stringify(tables).replaceAll("'", "''");
    await tx.raw(`CREATE FUNCTION ??.gather_ensure_runtime_role(p_site text, p_password text) RETURNS void
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $body$
      DECLARE role_name text; table_name text; role_row record;
      BEGIN
        IF p_site !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          OR p_password !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'Invalid runtime identity'; END IF;
        IF NOT EXISTS (SELECT 1 FROM ??.gather_sites WHERE id=p_site AND status IN ('active','provisioning'))
          THEN RAISE EXCEPTION 'Runtime site unavailable'; END IF;
        role_name := 'gather_site_' || replace(p_site, '-', '');
        SELECT * INTO role_row FROM pg_roles WHERE rolname=role_name;
        IF FOUND THEN
          IF role_row.rolsuper OR role_row.rolbypassrls OR role_row.rolcreaterole OR role_row.rolcreatedb OR role_row.rolinherit OR role_row.rolreplication
            THEN RAISE EXCEPTION 'Unsafe runtime role'; END IF;
          IF EXISTS (SELECT 1 FROM pg_auth_members WHERE member=role_row.oid)
            THEN RAISE EXCEPTION 'Runtime role membership is not permitted'; END IF;
          EXECUTE format('ALTER ROLE %I LOGIN PASSWORD %L', role_name, p_password);
        ELSE
          EXECUTE format('CREATE ROLE %I LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L', role_name, p_password);
        END IF;
        EXECUTE format('GRANT USAGE ON SCHEMA %I TO %I', '${schemaLiteral}', role_name);
        FOR table_name IN SELECT json_array_elements_text('${tableLiteral}'::json) LOOP
          EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I.%I TO %I', '${schemaLiteral}', table_name, role_name);
        END LOOP;
        FOR table_name IN SELECT tablename FROM pg_tables WHERE schemaname='${schemaLiteral}' AND tablename IN ('migrations','migrations_lock','gather_tenancy_state') LOOP
          EXECUTE format('GRANT SELECT ON %I.%I TO %I', '${schemaLiteral}', table_name, role_name);
        END LOOP;
        EXECUTE format('GRANT SELECT ON %I.members_resolved_subscription TO %I', '${schemaLiteral}', role_name);
      END $body$`, [schema, schema]);
    await tx.raw('REVOKE ALL ON FUNCTION ??.gather_ensure_runtime_role(text,text) FROM PUBLIC', [schema]);
    await tx.raw('GRANT EXECUTE ON FUNCTION ??.gather_ensure_runtime_role(text,text) TO ??', [schema, controlRole]);
    await tx('gather_tenancy_state').insert({ key: 'isolation', manifest_hash: TENANT_MANIFEST_HASH, legacy_site_id: legacySiteId, installed_at: new Date() });
  });
}

export async function verifyTenantDatabase(database: Knex, siteId: string) {
  const role = tenantRole(siteId);
  const identity = await database.raw(`SELECT session_user AS login, current_user AS role, gather_current_site() AS site,
    rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolinherit, rolreplication FROM pg_roles WHERE rolname=current_user`);
  const result = identity.rows[0];
  if (!result || result.login !== role || result.role !== role || result.site !== siteId || result.rolsuper || result.rolbypassrls || result.rolcreaterole || result.rolcreatedb || result.rolinherit || result.rolreplication) {
    throw new errors.IncorrectUsageError({ message: 'Unsafe or incorrect tenant database identity' });
  }
  const membership = await database.raw('SELECT 1 FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname=current_user)');
  if (membership.rows.length) {
    throw new errors.IncorrectUsageError({ message: 'Tenant runtime must not assume another database role' });
  }
  const state = await database('gather_tenancy_state').where({ key: 'isolation' }).first();
  if (state?.manifest_hash !== TENANT_MANIFEST_HASH) {
    throw new errors.IncorrectUsageError({ message: 'Tenant isolation inventory is not installed' });
  }
  const inventory = await database.raw(`SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity,
    pg_get_userbyid(c.relowner)=current_user AS owned FROM pg_class c
    JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=current_schema() AND c.relkind='r'`);
  for (const table of tables) {
    const row = inventory.rows.find((item: any) => item.relname === table);
    if (!row || !row.relrowsecurity || !row.relforcerowsecurity || row.owned) {
      throw new errors.IncorrectUsageError({ message: 'A publishing table is not isolated' });
    }
    const dangerous = await database.raw("SELECT has_table_privilege(current_user, ?, 'TRUNCATE') AS truncate, has_schema_privilege(current_user, current_schema(), 'CREATE') AS create", [table]);
    if (dangerous.rows[0].truncate || dangerous.rows[0].create) {
      throw new errors.IncorrectUsageError({ message: 'Tenant runtime has unsafe database privileges' });
    }
  }
}
