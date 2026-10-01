import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {createGateway} from './gather-assets.mjs';

test('private NAS delivery enforces origin authentication and public prefixes', async () => {
    const calls = [];
    const server = createGateway({
        bucket: 'gather-test', originSecret: 'a'.repeat(64),
        client: {async send(command) {
            calls.push(command.input);
            return {ContentType: 'image/png', ContentLength: 3, Body: Readable.from(['png'])};
        }}
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${server.address().port}`;
    try {
        assert.equal((await fetch(`${url}/__gather-origin-auth`)).status, 403);
        assert.equal((await fetch(`${url}/__gather-origin-auth`, {headers: {'x-gather-origin-key': 'a'.repeat(64)}})).status, 204);
        for (const path of ['content/settings/routes.yaml', 'content/images/%2e%2e/private', 'content/images/x%5cy', 'content/images/%00', '%ZZ']) {
            assert.ok([400, 404].includes((await fetch(`${url}/_assets/${path}`)).status));
        }
        assert.equal(calls.length, 0);
        const response = await fetch(`${url}/_assets/content/images/example.png`);
        assert.equal(response.status, 200);
        assert.equal(response.headers.get('content-type'), 'image/png');
        assert.equal(await response.text(), 'png');
        assert.deepEqual(calls[0], {Bucket: 'gather-test', Key: 'content/images/example.png'});
        assert.equal((await fetch(`${url}/_assets/content/images/x`, {method: 'POST'})).status, 405);
        assert.equal((await fetch(`${url}/_assets/content/images/x`, {headers: {range: 'bytes=1-2,3-4'}})).status, 416);
        assert.equal(calls.length, 1);
    } finally {
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
    }
});

test('range and NAS failure responses preserve HTTP semantics', async () => {
    const server = createGateway({
        bucket: 'gather-test', originSecret: 'a'.repeat(64),
        client: {async send(command) {
            if (command.input.Key.endsWith('missing')) throw {$metadata: {httpStatusCode: 404}};
            if (command.input.Key.endsWith('offline')) throw new Error('Unavailable');
            assert.ok(['bytes=1-2', 'bytes=-2'].includes(command.input.Range));
            return {ContentRange: command.input.Range === 'bytes=-2' ? 'bytes 2-3/4' : 'bytes 1-2/4', ContentLength: 2, Body: Readable.from(['ab'])};
        }}
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${server.address().port}/_assets/content/media/`;
    try {
        const response = await fetch(`${url}clip`, {headers: {range: 'bytes=1-2'}});
        assert.equal(response.status, 206);
        assert.equal(response.headers.get('content-range'), 'bytes 1-2/4');
        assert.equal(await response.text(), 'ab');
        const suffix = await fetch(`${url}clip`, {headers: {range: 'bytes=-2'}});
        assert.equal(suffix.status, 206);
        assert.equal(suffix.headers.get('content-range'), 'bytes 2-3/4');
        assert.equal((await fetch(`${url}missing`)).status, 404);
        const offline = await fetch(`${url}offline`);
        assert.equal(offline.status, 503);
        assert.equal(offline.headers.get('cache-control'), 'no-store');
    } finally {
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
    }
});
