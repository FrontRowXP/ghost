import {request as httpRequest} from 'node:http';
import {Readable} from 'node:stream';

// Node fetch ignores a supplied Host header. Internal tenant probes and the
// private staff bridge require the canonical Host on a loopback connection.
// Use HTTP transport directly; preserve fetch-style bodies and response APIs.
export async function loopbackRequest(port, path, options = {}) {
  if (!Number.isInteger(port) || port < 1 || port > 65535 || typeof path !== 'string' || !path.startsWith('/')) throw new Error('Invalid loopback request');
  const request = new Request('http://127.0.0.1:' + port + path, options);
  return new Promise((resolve, reject) => {
    const connection = httpRequest({hostname: '127.0.0.1', port, path, method: request.method,
      headers: Object.fromEntries(request.headers), signal: request.signal}, incoming => {
      const headers = new Headers();
      for (let i = 0; i < incoming.rawHeaders.length; i += 2) headers.append(incoming.rawHeaders[i], incoming.rawHeaders[i + 1]);
      const empty = request.method === 'HEAD' || [204, 205, 304].includes(incoming.statusCode);
      if (empty) incoming.resume();
      resolve(new Response(empty ? null : Readable.toWeb(incoming), {status: incoming.statusCode, headers}));
    });
    connection.on('error', reject);
    if (request.body) Readable.fromWeb(request.body).on('error', error => connection.destroy(error)).pipe(connection);
    else connection.end();
  });
}
