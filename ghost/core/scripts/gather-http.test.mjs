import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { loopbackRequest } from './gather-http.mjs';
test('loopback transport preserves canonical Host and separate staff cookies', async () => {
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    res.setHeader('Set-Cookie', ['first=a; HttpOnly', 'second=b; HttpOnly']);
    res.end(JSON.stringify({ host: req.headers.host, body }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const response = await loopbackRequest(server.address().port, '/', {
      method: 'POST',
      headers: { Host: 'site.gather.example.test' },
      body: 'delegation',
      signal: AbortSignal.timeout(2000),
    });
    assert.deepEqual(await response.json(), {
      host: 'site.gather.example.test',
      body: 'delegation',
    });
    assert.equal(response.headers.getSetCookie().length, 2);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
