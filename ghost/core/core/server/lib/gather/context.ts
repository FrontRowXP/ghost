import {AsyncLocalStorage} from 'node:async_hooks';
import type {Knex} from 'knex';

export interface SiteContext {
    readonly siteId: string;
    readonly workspaceId: string;
    readonly actorId: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const contexts = new AsyncLocalStorage<Readonly<SiteContext>>();

// Only a server-side registry and authorization decision may construct this
// context. A request body/header is never authority to choose a site.
export function withSiteContext<T>(context: SiteContext, work: () => T): T {
    if (!UUID.test(context.siteId) || !UUID.test(context.workspaceId) ||
        (context.actorId !== null && !UUID.test(context.actorId))) {
        throw new Error('Invalid site context');
    }
    const existing = contexts.getStore();
    if (existing && (existing.siteId !== context.siteId || existing.actorId !== context.actorId ||
        existing.workspaceId !== context.workspaceId)) {
        throw new Error('Cannot change site inside an active context');
    }
    return contexts.run(Object.freeze({...context}), work);
}

export function requireSiteContext(): Readonly<SiteContext> {
    const context = contexts.getStore();
    if (!context) throw new Error('Site context required');
    return context;
}

// New tenant-aware repositories use this boundary. It does not make the legacy
// global Bookshelf/Knex connection safe for multiple sites by itself.
export async function withSiteTransaction<T>(database: Knex, work: (tx: Knex.Transaction) => Promise<T>): Promise<T> {
    const context = requireSiteContext();
    if (database.client.config.client !== 'pg') throw new Error('Site isolation requires PostgreSQL');
    return database.transaction(async (tx) => {
        const role = await tx.raw('SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user');
        if (role.rows[0]?.rolsuper !== false || role.rows[0]?.rolbypassrls !== false) {
            throw new Error('Site runtime role must not bypass row security');
        }
        // This helper must not turn a context flag into a false isolation claim
        // while the legacy publishing tables are still unscoped.
        const tables = await tx.raw(`SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity,
            pg_get_userbyid(c.relowner) = current_user AS owned
            FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = current_schema() AND c.relname IN ('posts', 'users', 'settings', 'members')`);
        if (tables.rows.length !== 4 || tables.rows.some((table: any) =>
            !table.relrowsecurity || !table.relforcerowsecurity || table.owned)) {
            throw new Error('Publishing table isolation is not installed');
        }
        await tx.raw("SELECT set_config('gather.site_id', ?, true)", [context.siteId]);
        return work(tx);
    });
}
