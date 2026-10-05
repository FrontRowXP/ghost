import { randomUUID } from 'node:crypto';
import { domainToASCII } from 'node:url';
import type { Knex } from 'knex';
import { withSiteContext } from './context';

export interface Principal {
  user: { id: string; name: string };
  workspaces: Array<{ id: string; name: string; role: string }>;
}
export interface Site {
  id: string;
  workspace_id: string;
  name: string;
  slug: string;
  status: string;
}
export class SitesError extends Error {
  readonly statusCode: number;
  readonly code: string;
  constructor({ statusCode, code }: { statusCode: number; code: string }) {
    super(code);
    this.statusCode = statusCode;
    this.code = code;
  }
}
export function canonicalHostname(input: string): string {
  if (typeof input !== 'string' || /[\s/:@\\?#]/.test(input)) {
    throw new SitesError({ statusCode: 400, code: 'invalid_hostname' });
  }
  const hostname = domainToASCII(input.toLowerCase());
  if (
    !hostname ||
    hostname.length > 253 ||
    !hostname.includes('.') ||
    hostname.split('.').some((part) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(part))
  ) {
    throw new SitesError({ statusCode: 400, code: 'invalid_hostname' });
  }
  return hostname;
}

// The implementation deliberately cannot advertise creation readiness yet.
// These gates require the tenant-aware data/runtime release and real acceptance.
export const CREATION_BLOCKERS = Object.freeze([
  'shared_table_isolation',
  'tenant_runtime',
  'tenant_jobs',
  'tenant_assets',
  'tenant_recovery',
]);

export class SiteRegistry {
  private readonly database: Knex;
  private readonly provisioner?: {maximumSites: number; hostname(slug: string): string; queue(site: Site): void};
  constructor(database: Knex, provisioner?: {maximumSites: number; hostname(slug: string): string; queue(site: Site): void}) {
    this.database = database;
    this.provisioner = provisioner;
  }

  get creationEnabled() {
    return Boolean(this.provisioner);
  }

  async browse(principal: Principal) {
    const workspaceIds = principal.workspaces.map((workspace) => workspace.id);
    if (!workspaceIds.length) {
      return [];
    }
    // Workspace visibility is necessary but not a staff grant. An explicit
    // Moments subject-to-site staff link is also required to open Admin.
    return this.database('gather_sites as sites')
      .leftJoin('gather_site_staff as staff', function () {
        this.on('staff.site_id', '=', 'sites.id').andOnVal('staff.subject_id', principal.user.id);
      })
      .leftJoin('users as users', 'users.id', 'staff.staff_id')
      .leftJoin('gather_site_domains as domains', function () {
        this.on('domains.site_id', '=', 'sites.id').andOnVal('domains.is_primary', true);
      })
      .whereIn('sites.workspace_id', workspaceIds)
      .where(function () {
        this.where('users.status', 'active').orWhere(function () {
          this.whereIn('sites.status', ['provisioning', 'failed']).where('sites.created_by', principal.user.id)
            .whereIn('sites.workspace_id', principal.workspaces.filter(workspace => workspace.role === 'owner').map(workspace => workspace.id));
        });
      })
      .select(
        'sites.id',
        'sites.name',
        'sites.slug',
        'sites.workspace_id',
        'sites.status',
        'domains.hostname',
        'domains.verified_at',
      );
  }

  async resolve(hostname: string): Promise<Site> {
    const site = await this.database('gather_sites as sites')
      .join('gather_site_domains as domains', 'domains.site_id', 'sites.id')
      .where({ 'domains.hostname': canonicalHostname(hostname), 'sites.status': 'active' })
      .whereNotNull('domains.verified_at')
      .select('sites.*')
      .first();
    if (!site) {
      throw new SitesError({ statusCode: 404, code: 'site_not_found' });
    }
    return site;
  }

  async runForStaff<T>(
    siteId: string,
    principal: Principal,
    work: (site: Site) => Promise<T>,
  ): Promise<T> {
    const site = await this.database('gather_sites')
      .where({ id: siteId, status: 'active' })
      .first();
    if (!site || !principal.workspaces.some((workspace) => workspace.id === site.workspace_id)) {
      throw new SitesError({ statusCode: 404, code: 'site_not_found' });
    }
    const staff = await this.database('gather_site_staff')
      .where({ site_id: siteId, subject_id: principal.user.id })
      .first();
    if (!staff) {
      throw new SitesError({ statusCode: 404, code: 'site_not_found' });
    }
    // Local account revocation remains authoritative as well.
    const local = await this.database('users')
      .where({ id: staff.staff_id, status: 'active' })
      .first();
    if (!local) {
      throw new SitesError({ statusCode: 403, code: 'site_access_revoked' });
    }
    return withSiteContext(
      { siteId, workspaceId: site.workspace_id, actorId: principal.user.id },
      () => work(site),
    );
  }

  async registerExistingSite(input: {
    siteId: string;
    workspaceId: string;
    subjectId: string;
    staffId: string;
    name: string;
    hostname: string;
  }) {
    // Operator-only bootstrap; never exposed by the public router. The
    // caller must verify the immutable Moments identity and workspace first.
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (
      ![input.siteId, input.workspaceId, input.subjectId].every((value) => uuid.test(value)) ||
      !/^[0-9a-f]{24}$/i.test(input.staffId) ||
      typeof input.name !== 'string' ||
      !input.name.trim() ||
      input.name.length > 191
    ) {
      throw new SitesError({ statusCode: 400, code: 'invalid_site_binding' });
    }
    const hostname = canonicalHostname(input.hostname);
    return this.database.transaction(async (tx) => {
      const staff = await tx('users').where({ id: input.staffId, status: 'active' }).first();
      const owner = await tx('roles_users')
        .join('roles', 'roles_users.role_id', 'roles.id')
        .where({ 'roles_users.user_id': input.staffId, 'roles.name': 'Owner' })
        .first();
      if (!staff || !owner) {
        throw new SitesError({ statusCode: 403, code: 'existing_owner_required' });
      }
      const existing = await tx('gather_sites').where({ id: input.siteId }).first();
      if (existing && (existing.workspace_id !== input.workspaceId || existing.created_by !== input.subjectId || existing.slug !== 'gather' || existing.status !== 'active')) {
        throw new SitesError({ statusCode: 409, code: 'site_binding_conflict' });
      }
      const primary = existing && await tx('gather_site_domains').where({site_id: input.siteId, is_primary: true}).first();
      if (primary && primary.hostname !== hostname) throw new SitesError({statusCode: 409, code: 'site_binding_conflict'});
      await tx('gather_sites')
        .insert({
          id: input.siteId,
          workspace_id: input.workspaceId,
          name: input.name,
          slug: 'gather',
          status: 'active',
          created_by: input.subjectId,
          created_at: new Date(),
          updated_at: new Date(),
        })
        .onConflict('id')
        .ignore();
      const domain = await tx('gather_site_domains').where({ hostname }).first();
      if (domain && domain.site_id !== input.siteId) {
        throw new SitesError({ statusCode: 409, code: 'domain_in_use' });
      }
      await tx('gather_site_domains')
        .insert({
          id: randomUUID(),
          site_id: input.siteId,
          hostname,
          verified_at: new Date(),
          is_primary: true,
        })
        .onConflict('hostname')
        .ignore();
      const link = await tx('gather_site_staff')
        .where({ site_id: input.siteId, subject_id: input.subjectId })
        .first();
      if (link && link.staff_id !== input.staffId) {
        throw new SitesError({ statusCode: 409, code: 'staff_binding_conflict' });
      }
      await tx('gather_site_staff')
        .insert({
          id: randomUUID(),
          site_id: input.siteId,
          subject_id: input.subjectId,
          staff_id: input.staffId,
        })
        .onConflict(['site_id', 'subject_id'])
        .ignore();
    });
  }

  async create(input: { workspaceId?: string; name?: string; slug?: string }, principal: Principal) {
    const workspace = principal.workspaces.find((item) => item.id === input.workspaceId);
    if (workspace?.role !== 'owner') {
      throw new SitesError({ statusCode: 403, code: 'workspace_owner_required' });
    }
    const provisioner = this.provisioner;
    if (!provisioner) throw new SitesError({ statusCode: 503, code: 'site_creation_unavailable' });
    if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 191 ||
      typeof input.slug !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(input.slug) || input.slug.length > 40 ||
      ['gather', 'stage', 'www', 'api', 'auth', 'assets', 'admin'].includes(input.slug)) {
      throw new SitesError({statusCode: 400, code: 'invalid_site_details'});
    }
    // Slug is a durable idempotency key. A lost response/restart reuses the same
    // site only for the same verified creator/workspace/name, never a new grant.
    const site: Site = await this.database.transaction(async tx => {
      await tx.raw("SELECT pg_advisory_xact_lock(hashtextextended('gather-provisioning', 0))");
      const existing = await tx('gather_sites').where({slug: input.slug}).first();
      if (existing) {
        if (existing.workspace_id !== workspace.id || existing.created_by !== principal.user.id || existing.name !== input.name!.trim()) {
          throw new SitesError({statusCode: 409, code: 'site_address_in_use'});
        }
        if (!['active', 'provisioning', 'failed'].includes(existing.status)) throw new SitesError({statusCode: 409, code: 'site_address_in_use'});
        if (existing.status === 'failed') {
          await tx('gather_sites').where({id: existing.id}).update({status: 'provisioning', updated_at: new Date()});
          existing.status = 'provisioning';
        }
        return existing;
      }
      const count = await tx('gather_sites').count({count: '*'}).first();
      if (Number(count?.count) >= provisioner.maximumSites) throw new SitesError({statusCode: 429, code: 'site_capacity_reached'});
      const created = {id: randomUUID(), workspace_id: workspace.id, name: input.name!.trim(), slug: input.slug!, status: 'provisioning', created_by: principal.user.id, created_at: new Date(), updated_at: new Date()};
      await tx('gather_sites').insert(created);
      await tx('gather_site_domains').insert({id: randomUUID(), site_id: created.id, hostname: canonicalHostname(provisioner.hostname(created.slug)), is_primary: true, verified_at: null});
      return created;
    });
    if (site.status === 'provisioning') provisioner.queue(site);
    return site;
  }
}
