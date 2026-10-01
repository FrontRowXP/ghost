import {readFile} from 'node:fs/promises';
import {createHmac, randomUUID} from 'node:crypto';
import {deflateSync} from 'node:zlib';
import {createRequire} from 'node:module';

const args = Object.fromEntries(process.argv.slice(2).reduce((out, value, index, all) => {
    if (value.startsWith('--')) out.push([value.slice(2), all[index + 1]]);
    return out;
}, []));
const config = JSON.parse(await readFile(args.config, 'utf8'));
const lane = config[args.lane];
if (!lane || !lane.url.startsWith('https://')) throw new Error('HTTPS acceptance configuration is required');
const [kid, secret] = lane.adminKey.split(':');
if (!/^[0-9a-f]{24}$/.test(kid) || !/^[0-9a-f]{64}$/.test(secret)) throw new Error('Invalid Admin API key projection');
const now = Math.floor(Date.now() / 1000);
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
const signingInput = `${encode({alg: 'HS256', typ: 'JWT', kid})}.${encode({iat: now, exp: now + 300, aud: '/admin/'})}`;
const token = `${signingInput}.${createHmac('sha256', Buffer.from(secret, 'hex')).update(signingInput).digest('base64url')}`;
const identifier = `gather-acceptance-${randomUUID()}`;
let post;
const uploads = [];
async function request(path, {method = 'GET', body, expected = 200, authenticated = true} = {}) {
    const response = await fetch(new URL(path, lane.url), {
        method, body, headers: {Origin: lane.url, 'Accept-Version': 'v6.0',
            ...(authenticated ? {Authorization: `Ghost ${token}`} : {}),
            ...(typeof body === 'string' ? {'Content-Type': 'application/json'} : {})},
        signal: AbortSignal.timeout(90000)
    });
    if (response.status !== expected) throw new Error(`${method} ${path.split('?')[0]} returned ${response.status}, expected ${expected}`);
    return response;
}
function png() {
    const crc = bytes => {
        let value = 0xffffffff;
        for (const byte of bytes) {
            value ^= byte;
            for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
        }
        return (value ^ 0xffffffff) >>> 0;
    };
    const chunk = (name, data) => {
        const type = Buffer.from(name); const size = Buffer.alloc(4); size.writeUInt32BE(data.length);
        const checksum = Buffer.alloc(4); checksum.writeUInt32BE(crc(Buffer.concat([type, data])));
        return Buffer.concat([size, type, data, checksum]);
    };
    const header = Buffer.alloc(13); header.writeUInt32BE(16); header.writeUInt32BE(16, 4); header[8] = 8; header[9] = 2;
    const pixels = Buffer.alloc(16 * (16 * 3 + 1), 127);
    for (let row = 0; row < 16; row++) pixels[row * 49] = 0;
    return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}
async function upload(kind, bytes, extension, mime) {
    const form = new FormData(); form.append('file', new Blob([bytes], {type: mime}), `${identifier}.${extension}`);
    const result = await (await request(`/ghost/api/admin/${kind}/upload/`, {method: 'POST', body: form, expected: 201})).json();
    const url = new URL(result[kind][0].url);
    if (url.origin !== new URL(lane.url).origin || !url.pathname.startsWith(`/_assets/content/${kind}/`) || !url.pathname.includes(identifier)) throw new Error('Upload escaped the Gather asset namespace');
    uploads.push({kind, url});
    const response = await fetch(url, {signal: AbortSignal.timeout(90000)});
    if (response.status !== 200 || response.headers.get('content-type') !== mime) throw new Error('Public NAS asset delivery failed');
    const delivered = Buffer.from(await response.arrayBuffer());
    if (kind === 'images') {
        if (!delivered.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) throw new Error('PNG delivery failed');
    } else if (!delivered.equals(bytes)) throw new Error('NAS bytes changed');
    if (kind === 'media') {
        const range = await fetch(url, {headers: {Range: 'bytes=0-31'}, signal: AbortSignal.timeout(15000)});
        if (range.status !== 206 || !Buffer.from(await range.arrayBuffer()).equals(bytes.subarray(0, 32))) throw new Error('Video byte range failed');
    }
}
try {
    await request('/ghost/api/admin/site/', {authenticated: false});
    post = (await (await request('/ghost/api/admin/posts/?source=html', {method: 'POST', expected: 201,
        body: JSON.stringify({posts: [{title: 'Gather deployment acceptance', slug: identifier, html: '<p>Gather release acceptance.</p>', status: 'published'}]})})).json()).posts[0];
    const contentPath = `/ghost/api/content/posts/slug/${identifier}/?key=${encodeURIComponent(lane.contentKey)}`;
    const visible = (await (await request(contentPath, {authenticated: false})).json()).posts[0];
    if (visible.id !== post.id) throw new Error('Publishing persistence failed');
    await upload('images', png(), 'png', 'image/png');
    const media = await readFile(config.mediaFixturePath);
    if (media.length <= 5 * 1024 * 1024) throw new Error('Multipart fixture must exceed 5 MiB');
    await upload('media', media, 'mp4', 'video/mp4');
    await upload('files', Buffer.from('Gather deployment file acceptance\n'), 'txt', 'text/plain');
    const edits = await Promise.all(['A', 'B'].map(title => fetch(new URL(`/ghost/api/admin/posts/${post.id}/`, lane.url), {
        method: 'PUT', headers: {Origin: lane.url, 'Accept-Version': 'v6.0', Authorization: `Ghost ${token}`, 'Content-Type': 'application/json'},
        body: JSON.stringify({posts: [{updated_at: post.updated_at, title: `Gather deployment acceptance ${title}`}]}),
        signal: AbortSignal.timeout(30000)
    })));
    if (edits.map(response => response.status).sort().join(',') !== '200,409') throw new Error('Concurrent edits did not enforce optimistic locking');
    post = (await edits.find(response => response.status === 200).json()).posts[0];
    if (new Set(post.authors.map(author => author.id)).size !== post.authors.length) throw new Error('Concurrent edits duplicated post authors');
    await request(`/ghost/api/admin/posts/${post.id}/`, {method: 'PUT', body: JSON.stringify({posts: [{updated_at: post.updated_at, status: 'draft'}]})});
    await request(contentPath, {expected: 404, authenticated: false});
    console.log(`Gather ${args.lane} acceptance passed: publishing, concurrent edit exclusion, unpublishing, images, multipart video, files and byte ranges.`);
} finally {
    if (post) await request(`/ghost/api/admin/posts/${post.id}/`, {method: 'DELETE', expected: 204});
    const require = createRequire(new URL('../../ghost/core/package.json', import.meta.url));
    const {S3Client, DeleteObjectCommand} = require('@aws-sdk/client-s3');
    const storage = lane.storage;
    const client = new S3Client({region: storage.region, endpoint: storage.endpoint, forcePathStyle: true,
        credentials: {accessKeyId: storage.accessKeyId, secretAccessKey: storage.secretAccessKey}});
    try {
        for (const {kind, url} of uploads) {
            const key = decodeURIComponent(url.pathname.slice('/_assets/'.length));
            if (!key.startsWith(`content/${kind}/`) || !key.includes(identifier) || key.includes('..')) throw new Error('Unsafe acceptance cleanup key');
            await client.send(new DeleteObjectCommand({Bucket: storage.bucket, Key: key}));
            if (kind === 'images') await client.send(new DeleteObjectCommand({Bucket: storage.bucket, Key: key.replace(/\.png$/, '_o.png')}));
        }
    } finally {client.destroy();}
}
