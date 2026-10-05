import {randomUUID} from 'node:crypto';
import {domainToASCII} from 'node:url';
import type {Knex} from 'knex';
import {withSiteContext} from './context';

export interface Principal {
    user: {id: string; name: string};
    workspaces: Array<{id: string; name: string; role: string}>;
}
export interface Site {
    id: string; workspace_id: string; name: string; slug: string; status: string;
}
export class SitesError extends Error {
    readonly statusCode: number;
    readonly code: string;
    constructor(statusCode: number, code: string) { super(code); this.statusCode = statusCode; this.code = code; }
}
export function canonicalHostname(input: string): string {
    if (typeof input !== 'string' || /[\s/:@\\?#]/.test(input)) throw new SitesError(400, 'invalid_hostname');
const hostname = domainToASCII(input.toLowerCase());
    if (!hostname || hostname.length > 253 || !hostname.includes('.') ||
        hostname.split('.').some(part => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(part))) {
        throw new SitesError(400, 'invalid_hostname');
    }
    return hostname;
}

// The implementation deliberately cannot advertise creation readiness yet.
// These gates require the tenant-aware data/runtime release and real acceptance.
export const CREATION_BLOCKERS = Object.freeze([
    'shared_table_isolation', 'tenant_runtime', 'tenant_jobs', 'tenant_assets', 'tenant_recovery',
]);

export class SiteRegistry {
    private readonly database: Knex;
    constructor(database: Knex) { this.database = database; }

    async browse(principal: Principal) {
        const workspaceIds = principal.workspaces.map(workspace => workspace.id);
        if (!workspaceIds.length) return [];
        // Workspace visibility is necessary but not a staff grant. An explicit
        // Moments subject-to-site staff link is also required to open Admin.
        return this.database('gather_sites as sites')
            .join('gather_site_staff as staff', 'staff.site_id', 'sites.id')
            .join('users as users', 'users.id', 'staff.staff_id')
            .leftJoin('gather_site_domains as domains', function () {
                this.on('domains.site_id', '=', 'sites.id').andOnVal('domains.is_primary', true);
            })
            .whereIn('sites.workspace_id', workspaceIds)
            .where('staff.subject_id', principal.user.id)
            .where('users.status', 'active')
            .select('sites.id', 'sites.name', 'sites.slug', 'sites.workspace_id', 'sites.status', 'domains.hostname', 'domains.verified_at');
    }

    async resolve(hostname: string): Promise<Site> {
        const site = await this.database('gather_sites as sites')
            .join('gather_site_domains as domains', 'domains.site_id', 'sites.id')
            .where({'domains.hostname': canonicalHostname(hostname), 'sites.status': 'active'})
            .whereNotNull('domains.verified_at').select('sites.*').first();
        if (!site) throw new SitesError(404, 'site_not_found');
        return site;
    }

    async runForStaff<T>(siteId: string, principal: Principal, work: (site: Site) => Promise<T>): Promise<T> {
        const site = await this.database('gather_sites').where({id: siteId, status: 'active'}).first();
        if (!site || !principal.workspaces.some(workspace => workspace.id === site.workspace_id)) {
            throw new SitesError(404, 'site_not_found');
        }
        const staff = await this.database('gather_site_staff').where({site_id: siteId, subject_id: principal.user.id}).first();
        if (!staff) throw new SitesError(404, 'site_not_found');
        // Local account revocation remains authoritative as well.
        const local = await this.database('users').where({id: staff.staff_id, status: 'active'}).first();
        if (!local) throw new SitesError(403, 'site_access_revoked');
        return withSiteContext({siteId, workspaceId: site.workspace_id, actorId: principal.user.id}, () => work(site));
    }

    async registerExistingSite(input: {
        siteId: string; workspaceId: string; subjectId: string; staffId: string; name: string; hostname: string;
    }) {
        // Operator-only bootstrap; never exposed by the public router. The
        // caller must verify the immutable Moments identity and workspace first.
        const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        if (![input.siteId, input.workspaceId, input.subjectId].every(value => uuid.test(value)) ||
            !/^[0-9a-f]{24}$/i.test(input.staffId) || typeof input.name !== 'string' ||
            !input.name.trim() || input.name.length > 191) {
            throw new SitesError(400, 'invalid_site_binding');
        }
        const hostname = canonicalHostname(input.hostname);
        return this.database.transaction(async (tx) => {
            const staff = await tx('users').where({id: input.staffId, status: 'active'}).first();
            const owner = await tx('roles_users').join('roles', 'roles_users.role_id', 'roles.id')
                .where({'roles_users.user_id': input.staffId, 'roles.name': 'Owner'}).first();
            if (!staff || !owner) throw new SitesError(403, 'existing_owner_required');
            const existing = await tx('gather_sites').where({id: input.siteId}).first();
            if (existing && existing.workspace_id !== input.workspaceId) throw new SitesError(409, 'site_binding_conflict');
            await tx('gather_sites').insert({id: input.siteId, workspace_id: input.workspaceId, name: input.name,
                slug: 'gather', status: 'active', created_by: input.subjectId, created_at: new Date(), updated_at: new Date()})
                .onConflict('id').ignore();
            const domain = await tx('gather_site_domains').where({hostname}).first();
            if (domain && domain.site_id !== input.siteId) throw new SitesError(409, 'domain_in_use');
            await tx('gather_site_domains').insert({id: randomUUID(), site_id: input.siteId, hostname,
                verified_at: new Date(), is_primary: true}).onConflict('hostname').ignore();
            const link = await tx('gather_site_staff').where({site_id: input.siteId, subject_id: input.subjectId}).first();
            if (link && link.staff_id !== input.staffId) throw new SitesError(409, 'staff_binding_conflict');
            await tx('gather_site_staff').insert({id: randomUUID(), site_id: input.siteId,
                subject_id: input.subjectId, staff_id: input.staffId}).onConflict(['site_id', 'subject_id']).ignore();
        });
    }

    async create(input: {workspaceId?: string}, principal: Principal): Promise<never> {
        const workspace = principal.workspaces.find(item => item.id === input.workspaceId);
        if (workspace?.role !== 'owner') throw new SitesError(403, 'workspace_owner_required');
        // No rows/jobs/assets are created until every isolation gate is real.
        throw new SitesError(503, 'site_creation_unavailable');
    }
}
