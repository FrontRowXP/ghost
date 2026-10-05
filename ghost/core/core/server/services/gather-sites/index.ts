import config from '../../../shared/config';
import {SiteRegistry} from '../../lib/gather/registry';
import {SealedRedisStore} from '../../lib/gather/redis-store';
import {createSiteHub} from './hub';

let hub: ReturnType<typeof createSiteHub> | undefined;
let redis: {quit(): Promise<unknown>} | undefined;
export async function init() {
    if (hub) return;
    if (config.get('gather:sites:enabled') !== true) return;
    if (config.get('database:client') !== 'pg' || !config.get('security:frontroAuth:enabled')) {
        throw new Error('Gather site management requires PostgreSQL and Moments authentication');
    }
    const urlUtils = require('../../../shared/url-utils').default;
    const origin = new URL(urlUtils.getAdminUrl() || urlUtils.getSiteUrl()).origin;
    if (!origin.startsWith('https://')) throw new Error('Gather site management requires HTTPS');
    const settings = config.get('gather:sites');
    if (!['staging', 'production'].includes(settings.environment) || !settings.redis?.host) {
        throw new Error('Gather site management requires environment and shared Redis');
    }
    const database = require('../../data/db').knex;
    for (const name of ['gather_sites', 'gather_site_domains', 'gather_site_staff']) {
        if (!(await database.schema.hasTable(name))) throw new Error('Gather site registry migration is missing');
    }
    // Own this connection rather than reusing the global cache adapter's client.
    const redisStore = require('cache-manager-ioredis').create(settings.redis);
    const client = redisStore.getClient();
    redis = client;
    const prefix = `gather:{${settings.environment}-sites}`;
    try {
        const sessions = new SealedRedisStore(client, `${prefix}:sessions`, settings.sessionSealingKey, 10000);
        const handoffs = new SealedRedisStore(client, `${prefix}:handoffs`, settings.sessionSealingKey);
        hub = createSiteHub({registry: new SiteRegistry(database), sessions, handoffs, origin,
            cookiePath: urlUtils.getSubdir() + '/ghost', apiOrigin: config.get('security:frontroAuth:apiOrigin')});
    } catch (error) { await shutdown(); throw error; }
}
export function getHub() { return hub; }
export async function shutdown() {
    hub = undefined;
    const connection = redis;
    redis = undefined;
    if (connection) await connection.quit();
}
