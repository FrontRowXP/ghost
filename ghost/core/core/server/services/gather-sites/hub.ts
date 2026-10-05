import {randomBytes, timingSafeEqual} from 'node:crypto';
import type {Request, Response} from 'express';
import {SiteRegistry, SitesError, CREATION_BLOCKERS, type Principal} from '../../lib/gather/registry';
import {SealedRedisStore} from '../../lib/gather/redis-store';

const {createFrontroAuth} = require('../auth/frontro-auth');
const COOKIE = '__Secure-frontro-sites-session';
const TOKEN = /^[a-f0-9]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
interface Delegation {cookie: string; subject: string; csrf: string}
interface HubSession {delegation: Delegation; csrf: string; expiresAt: number}
function tokenFrom(req: Request) {
    const cookies = (req.get('cookie') || '').split(';').map(value => value.trim())
        .filter(value => value.startsWith(COOKIE + '='));
    const token = cookies.length === 1 ? cookies[0].slice(COOKIE.length + 1) : '';
    return TOKEN.test(token) ? token : null;
}
function verifiedPrincipal(value: any): Principal {
    if (!UUID.test(value?.user?.id) || !Array.isArray(value?.workspaces) || value.workspaces.length > 1000 ||
        value.workspaces.some((workspace: any) => !UUID.test(workspace?.id) ||
            typeof workspace.name !== 'string' || !['owner', 'member'].includes(workspace.role))) {
        throw new SitesError(503, 'identity_unavailable');
    }
    return {user: {id: value.user.id, name: typeof value.user.name === 'string' ? value.user.name : ''},
        workspaces: value.workspaces.map(({id, name, role}: any) => ({id, name, role}))};
}

export function createSiteHub({registry, sessions, handoffs, origin, cookiePath, apiOrigin, now = Date.now, fetch = globalThis.fetch}: {
    registry: SiteRegistry; sessions: SealedRedisStore; handoffs: SealedRedisStore;
    origin: string; cookiePath: string; apiOrigin: string; now?: () => number; fetch?: typeof globalThis.fetch;
}) {
    const cookieOptions = {secure: true, httpOnly: true, sameSite: 'lax' as const, path: cookiePath};
    const auth = createFrontroAuth({
        getConfig: () => ({enabled: true, apiOrigin}),
        getAdminOrigin: () => origin, getAdminPath: () => cookiePath,
        handoffStore: handoffs, bindingCookie: '__Secure-frontro-sites-handoff', now, fetch,
        async acceptIdentity(req: Request, res: Response, raw: unknown, delegation: Delegation) {
            verifiedPrincipal(raw);
            const old = tokenFrom(req);
            if (old) {
                const previous: HubSession | null = await sessions.consume(old);
                if (previous) await auth.revoke(previous.delegation);
            }
            const token = randomBytes(32).toString('hex');
            const expiresAt = now() + 6 * 60 * 60 * 1000;
            if (!(await sessions.reserve(token, expiresAt))) throw new SitesError(429, 'site_sessions_busy');
            try {
                await sessions.put(token, {delegation, csrf: randomBytes(32).toString('hex'), expiresAt});
                res.cookie(COOKIE, token, {...cookieOptions, maxAge: expiresAt - now()});
            } catch (error) { await sessions.delete(token); throw error; }
        },
    });
    function sameOrigin(req: Request) {
        if (req.get('origin') !== origin) throw new SitesError(403, 'origin_denied');
    }
    async function current(req: Request) {
        const token = tokenFrom(req);
        const session: HubSession | null = token ? await sessions.get(token) : null;
        if (!session || session.expiresAt <= now()) throw new SitesError(401, 'authentication_required');
        // Workspace removal/disabled identity is checked against Moments on
        // every request. Browser-provided account/workspace objects are ignored.
        const principal = verifiedPrincipal(await auth.identity(session.delegation));
        return {token: token!, session, principal};
    }
    function csrf(req: Request, session: HubSession) {
        sameOrigin(req);
        const supplied = req.get('x-csrf-token') || '';
        if (!TOKEN.test(supplied) || !timingSafeEqual(Buffer.from(supplied), Buffer.from(session.csrf))) {
            throw new SitesError(403, 'csrf_invalid');
        }
    }
    return {
        async start(req: Request, res: Response) { return auth.start(req, res); },
        async complete(req: Request, res: Response) { return auth.complete(req, res); },
        async session(req: Request, res: Response) {
            const {session, principal} = await current(req);
            return res.json({...principal, csrfToken: session.csrf, creationEnabled: false});
        },
        async browse(req: Request, res: Response) {
            const {principal} = await current(req);
            return res.json({sites: await registry.browse(principal), creationEnabled: false});
        },
        async create(req: Request, res: Response) {
            const {session, principal} = await current(req);
            csrf(req, session);
            await registry.create(req.body || {}, principal);
            return res.sendStatus(201);
        },
        async logout(req: Request, res: Response) {
            const token = tokenFrom(req);
            const session: HubSession | null = token ? await sessions.get(token) : null;
            if (session) {
                csrf(req, session);
                await sessions.delete(token);
                await auth.revoke(session.delegation);
            } else sameOrigin(req);
            await auth.discard(req, res);
            res.clearCookie(COOKIE, cookieOptions);
            return res.sendStatus(204);
        },
        capability: {apiOrigin, creationEnabled: false, version: 1},
        blockers: CREATION_BLOCKERS,
    };
}
