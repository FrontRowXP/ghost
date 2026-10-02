import {readFileSync} from 'node:fs';

const config = JSON.parse(readFileSync(process.env.GATHER_RUNTIME_CONFIG || 'config.production.json', 'utf8'));
const secret = config.security?.gatherOriginSecret;
if (typeof secret !== 'string' || secret.length < 48) throw new Error('Gather readiness requires its projected origin credential');
const response = await fetch('http://127.0.0.1:2368/ghost/api/admin/site/', {
    headers: {Host: new URL(config.url).host, 'X-Forwarded-Proto': 'https', 'X-Gather-Origin-Key': secret},
    signal: AbortSignal.timeout(3500)
});
if (response.status !== 200) throw new Error(`Gather readiness returned ${response.status}`);
await response.body?.cancel();
