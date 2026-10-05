import { createHash, randomBytes } from 'node:crypto';
import type { Request, Response } from 'express';
import type { Knex } from 'knex';
import { SiteRegistry, SitesError, type Principal } from './registry';
import { SealedRedisStore } from './redis-store';

const TOKEN = /^[a-f0-9]{64}$/;
const COOKIE = '__Host-gather-site-login';
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
type Delegation = { cookie: string; subject: string; csrf: string };
interface Flow {
  siteId: string;
  hostname: string;
  binding: string;
  expiresAt: number;
}
interface Grant extends Flow {
  flow: string;
  delegation: Delegation;
}

export function createStaffLogin({
  database,
  registry,
  flows,
  grants,
  hubOrigin,
}: {
  database: Knex;
  registry: SiteRegistry;
  flows: SealedRedisStore;
  grants: SealedRedisStore;
  hubOrigin: string;
}) {
  async function read(flow: string) {
    const stored: Flow | null = TOKEN.test(flow) ? await flows.get(flow) : null;
    if (!stored || stored.expiresAt <= Date.now()) {
      throw new SitesError({ statusCode: 401, code: 'site_login_expired' });
    }
    const site = await database('gather_sites')
      .where({ id: stored.siteId, status: 'active' })
      .first();
    if (!site) {
      throw new SitesError({ statusCode: 404, code: 'site_not_found' });
    }
    return { name: site.name, hostname: stored.hostname };
  }
  return {
    read,
    async start(req: Request, res: Response, siteId: string, hostname: string) {
      const domain = await database('gather_site_domains')
        .where({ site_id: siteId, hostname })
        .whereNotNull('verified_at')
        .first();
      if (!domain) {
        throw new SitesError({ statusCode: 404, code: 'site_not_found' });
      }
      const flow = randomBytes(32).toString('hex');
      const binding = randomBytes(32).toString('hex');
      const expiresAt = Date.now() + 600000;
      if (!(await flows.reserve(flow, expiresAt))) {
        throw new SitesError({ statusCode: 429, code: 'site_sessions_busy' });
      }
      await flows.put(flow, { siteId, hostname, binding: digest(binding), expiresAt });
      res.cookie(COOKIE, flow + '.' + binding, {
        httpOnly: true,
        secure: true,
        sameSite: 'lax',
        path: '/',
        maxAge: 600000,
      });
      res.set('Cache-Control', 'no-store');
      res.set('Referrer-Policy', 'no-referrer');
      res.redirect(hubOrigin + '/ghost/?gatherLogin=' + flow + '#/sites');
    },
    async complete(flow: string, principal: Principal, delegation: Delegation) {
      await read(flow);
      const stored: Flow | null = await flows.get(flow);
      if (!stored) {
        throw new SitesError({ statusCode: 401, code: 'site_login_expired' });
      }
      return registry.runForStaff(stored.siteId, principal, async () => {
        if (!(await flows.consume(flow))) {
          throw new SitesError({ statusCode: 401, code: 'site_login_expired' });
        }
        const token = randomBytes(32).toString('hex');
        const expiresAt = Date.now() + 60000;
        if (!(await grants.reserve(token, expiresAt))) {
          throw new SitesError({ statusCode: 429, code: 'site_sessions_busy' });
        }
        await grants.put(token, { ...stored, flow, delegation, expiresAt });
        return (
          'https://' +
          stored.hostname +
          '/ghost/_gather/signin/complete/?flow=' +
          flow +
          '&grant=' +
          token
        );
      });
    },
    async consume(req: Request, hostname: string, siteId: string): Promise<Delegation> {
      const flow = req.query.flow;
      const token = req.query.grant;
      const cookies = (req.get('cookie') || '')
        .split(';')
        .map((value) => value.trim())
        .filter((value) => value.startsWith(COOKIE + '='));
      const cookie = cookies.length === 1 ? cookies[0].slice(COOKIE.length + 1) : '';
      const [cookieFlow, binding] = cookie.split('.');
      if (
        typeof flow !== 'string' ||
        typeof token !== 'string' ||
        !TOKEN.test(flow) ||
        !TOKEN.test(token) ||
        !TOKEN.test(binding || '') ||
        cookieFlow !== flow
      ) {
        throw new SitesError({ statusCode: 401, code: 'site_login_expired' });
      }
      const stored: Grant | null = await grants.get(token);
      if (
        !stored ||
        stored.expiresAt <= Date.now() ||
        stored.flow !== flow ||
        stored.hostname !== hostname ||
        stored.siteId !== siteId ||
        stored.binding !== digest(binding)
      ) {
        throw new SitesError({ statusCode: 401, code: 'site_login_expired' });
      }
      const consumed: Grant | null = await grants.consume(token);
      if (!consumed) {
        throw new SitesError({ statusCode: 401, code: 'site_login_expired' });
      }
      return consumed.delegation;
    },
  };
}
