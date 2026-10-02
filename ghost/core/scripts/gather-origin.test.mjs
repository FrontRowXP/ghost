import {test} from 'node:test';
import assert from 'node:assert/strict';
import {gatherOrigin} from '../core/server/web/parent/middleware/gather-origin.ts';

test('hosted Core rejects missing credentials at startup and on requests', () => {
    assert.throws(() => gatherOrigin({required: true}), /strong origin credential/);
    assert.throws(() => gatherOrigin({secret: 'short'}), /strong origin credential/);
    const middleware = gatherOrigin({secret: 'a'.repeat(64), required: true});
    for (const header of [undefined, 'short', 'b'.repeat(64), ['a'.repeat(64)]]) {
        let denied = false;
        const response = {setHeader(name, value) {assert.equal(name, 'Cache-Control'); assert.equal(value, 'no-store');}, end() {denied = true;}};
        middleware({headers: {'x-gather-origin-key': header}}, response, () => assert.fail('Invalid origin reached Core'));
        assert.equal(response.statusCode, 403);
        assert.equal(denied, true);
    }
});

test('the trusted CDN reaches Core while standalone upstream behavior remains available', () => {
    let reached = 0;
    gatherOrigin({secret: 'a'.repeat(64)})({headers: {'x-gather-origin-key': 'a'.repeat(64)}}, {}, () => reached++);
    gatherOrigin({})({headers: {}}, {}, () => reached++);
    assert.equal(reached, 2);
});
