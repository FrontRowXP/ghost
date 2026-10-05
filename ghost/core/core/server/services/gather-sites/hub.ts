import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { Request, Response } from 'express';
import {
  SiteRegistry,
  SitesError,
  CREATION_BLOCKERS,
  type Principal,
} from '../../lib/gather/registry';
import { SealedRedisStore } from '../../lib/gather/redis-store';

const { createFrontroAuth } = require('../auth/frontro-auth');
const LEGACY_COOKIE = '__Secure-frontro-sites-session';
const TOKEN = /^[a-f0-9]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
interface Delegation {
  cookie: string;
  subject: string;
  csrf: string;
}
interface HubSession {
  delegation: Delegation;
  csrf: string;
  expiresAt: number;
}
function tokenFrom(req: Request, cookieName = LEGACY_COOKIE) {
  const cookies = (req.get('cookie') || '')
    .split(';')
    .map((value) => value.trim())
    .filter((value) => value.startsWith(cookieName + '='));
  const token = cookies.length === 1 ? cookies[0].slice(cookieName.length + 1) : '';
  return TOKEN.test(token) ? token : null;
}
function verifiedPrincipal(value: any): Principal {
  if (
    !UUID.test(value?.user?.id) ||
    !Array.isArray(value?.workspaces) ||
    value.workspaces.length > 1000 ||
    value.workspaces.some(
      (workspace: any) =>
        !UUID.test(workspace?.id) ||
        typeof workspace.name !== 'string' ||
        !['owner', 'member'].includes(workspace.role),
    )
  ) {
    throw new SitesError({ statusCode: 503, code: 'identity_unavailable' });
  }
  return {
    user: { id: value.user.id, name: typeof value.user.name === 'string' ? value.user.name : '' },
    workspaces: value.workspaces.map(({ id, name, role }: any) => ({ id, name, role })),
  };
}

export function createSiteHub({
  registry,
  sessions,
  handoffs,
  origin,
  cookiePath,
  apiOrigin,
  now = Date.now,
  fetch = globalThis.fetch,
  staffLogin,
}: {
  registry: SiteRegistry;
  sessions: SealedRedisStore;
  handoffs: SealedRedisStore;
  origin: string;
  cookiePath: string;
  apiOrigin: string;
  now?: () => number;
  fetch?: typeof globalThis.fetch;
  staffLogin?: {
    read(flow: string): Promise<{ name: string }>;
    complete(flow: string, principal: Principal, delegation: Delegation): Promise<string>;
  };
}) {
  const COOKIE = cookiePath === '/' ? '__Host-frontro-sites-session' : LEGACY_COOKIE;
  const cookieOptions = {
    secure: true,
    httpOnly: true,
    sameSite: 'lax' as const,
    path: cookiePath,
  };
  const auth = createFrontroAuth({
    getConfig: () => ({ enabled: true, apiOrigin }),
    getAdminOrigin: () => origin,
    getAdminPath: () => cookiePath,
    handoffStore: handoffs,
    bindingCookie:
      cookiePath === '/' ? '__Host-frontro-sites-handoff' : '__Secure-frontro-sites-handoff',
    now,
    fetch,
    async acceptIdentity(req: Request, res: Response, raw: unknown, delegation: Delegation) {
      verifiedPrincipal(raw);
      const old = tokenFrom(req, COOKIE);
      if (old) {
        const previous: HubSession | null = await sessions.consume(old);
        if (previous) {
          await auth.revoke(previous.delegation);
        }
      }
      const token = randomBytes(32).toString('hex');
      const expiresAt = now() + 6 * 60 * 60 * 1000;
      if (!(await sessions.reserve(token, expiresAt))) {
        throw new SitesError({ statusCode: 429, code: 'site_sessions_busy' });
      }
      try {
        await sessions.put(token, { delegation, csrf: randomBytes(32).toString('hex'), expiresAt });
        res.cookie(COOKIE, token, { ...cookieOptions, maxAge: expiresAt - now() });
      } catch (error) {
        await sessions.delete(token);
        throw error;
      }
    },
  });
  function sameOrigin(req: Request) {
    if (req.get('origin') !== origin) {
      throw new SitesError({ statusCode: 403, code: 'origin_denied' });
    }
  }
  async function current(req: Request) {
    const token = tokenFrom(req, COOKIE);
    const session: HubSession | null = token ? await sessions.get(token) : null;
    if (!session || session.expiresAt <= now()) {
      throw new SitesError({ statusCode: 401, code: 'authentication_required' });
    }
    // Workspace removal/disabled identity is checked against Moments on
    // every request. Browser-provided account/workspace objects are ignored.
    const principal = verifiedPrincipal(await auth.identity(session.delegation));
    return { token: token!, session, principal };
  }
  function csrf(req: Request, session: HubSession) {
    sameOrigin(req);
    const supplied = req.get('x-csrf-token') || '';
    if (
      !TOKEN.test(supplied) ||
      !timingSafeEqual(Buffer.from(supplied), Buffer.from(session.csrf))
    ) {
      throw new SitesError({ statusCode: 403, code: 'csrf_invalid' });
    }
  }
  return {
    async start(req: Request, res: Response) {
      return auth.start(req, res);
    },
    async complete(req: Request, res: Response) {
      return auth.complete(req, res);
    },
    async session(req: Request, res: Response) {
      const { session, principal } = await current(req);
      return res.json({
        ...principal,
        csrfToken: session.csrf,
        creationEnabled: registry.creationEnabled === true,
      });
    },
    async browse(req: Request, res: Response) {
      const { principal } = await current(req);
      return res.json({
        sites: await registry.browse(principal),
        creationEnabled: registry.creationEnabled === true,
      });
    },
    async create(req: Request, res: Response) {
      const { session, principal } = await current(req);
      csrf(req, session);
      const site = await registry.create(req.body || {}, principal);
      return res.status(201).json({ site });
    },
    async readStaffLogin(req: Request, res: Response) {
      if (!staffLogin || typeof req.query.flow !== 'string' || !TOKEN.test(req.query.flow)) {
        throw new SitesError({ statusCode: 404, code: 'site_not_found' });
      }
      return res.json(await staffLogin.read(req.query.flow));
    },
    async completeStaffLogin(req: Request, res: Response) {
      const { session, principal } = await current(req);
      csrf(req, session);
      if (!staffLogin || !TOKEN.test(req.body?.flow || '')) {
        throw new SitesError({ statusCode: 404, code: 'site_not_found' });
      }
      return res.json({
        redirect: await staffLogin.complete(req.body.flow, principal, session.delegation),
      });
    },
    async logout(req: Request, res: Response) {
      const token = tokenFrom(req, COOKIE);
      const session: HubSession | null = token ? await sessions.get(token) : null;
      if (session) {
        csrf(req, session);
        await sessions.delete(token);
        await auth.revoke(session.delegation);
      } else {
        sameOrigin(req);
      }
      await auth.discard(req, res);
      res.clearCookie(COOKIE, cookieOptions);
      return res.sendStatus(204);
    },
    capability: { apiOrigin, creationEnabled: registry.creationEnabled === true, version: 1 },
    blockers: registry.creationEnabled === true ? [] : CREATION_BLOCKERS,
  };
}
