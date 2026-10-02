import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';
import { S3Client, GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';

/** Serve only public upload prefixes from a private S3 bucket. */
export function createGateway({ client, bucket, originSecret }) {
  if (!bucket || !originSecret || originSecret.length < 48) {
    throw new Error('Gather assets require a bucket and a strong origin credential.');
  }
  const expected = Buffer.from(originSecret);
  return createServer(async (request, response) => {
    try {
      const path = (request.url || '/').split('?')[0];
      if (path === '/__gather-origin-auth') {
        const supplied = Buffer.from(request.headers['x-gather-origin-key'] || '');
        response.writeHead(supplied.length === expected.length && timingSafeEqual(supplied, expected) ? 204 : 403);
        response.end();
        return;
      }
      if (!['GET', 'HEAD'].includes(request.method)) {
        response.writeHead(405, { Allow: 'GET, HEAD' });
        response.end();
        return;
      }
      if (path === '/healthz') {
        await client.send(new HeadObjectCommand({ Bucket: bucket, Key: 'content/images/.gather-health' }), { abortSignal: AbortSignal.timeout(3500) });
        response.writeHead(200, { 'Cache-Control': 'no-store' });
        response.end();
        return;
      }
      const supplied = Buffer.from(request.headers['x-gather-origin-key'] || '');
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
        response.writeHead(403, {'Cache-Control': 'no-store'}).end();
        return;
      }
      let key;
      try {
        if (!path.startsWith('/_assets/')) {
          response.writeHead(404).end();
          return;
        }
        key = decodeURIComponent(path.slice('/_assets/'.length));
      } catch {
        response.writeHead(400).end();
        return;
      }
      if (!['content/images/', 'content/media/', 'content/files/'].some(prefix => key.startsWith(prefix)) ||
          key.split('/').some(part => part === '..' || part === '.') || /[\\\x00-\x1f\x7f]/.test(key)) {
        response.writeHead(404).end();
        return;
      }
      const options = { Bucket: bucket, Key: key };
      if (request.headers.range) {
        if (!/^bytes=(\d+-\d*|-\d+)$/.test(request.headers.range)) {
          response.writeHead(416).end();
          return;
        }
        options.Range = request.headers.range;
      }
      const command = request.method === 'HEAD' ? new HeadObjectCommand(options) : new GetObjectCommand(options);
      const object = await client.send(command, { abortSignal: AbortSignal.timeout(30000) });
      const headers = {
        'Content-Type': object.ContentType || 'application/octet-stream',
        'Cache-Control': 'public, max-age=60',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; sandbox",
        'Accept-Ranges': 'bytes',
      };
      if (key.startsWith('content/files/')) headers['Content-Disposition'] = 'attachment';
      if (object.ContentLength !== undefined) headers['Content-Length'] = String(object.ContentLength);
      if (object.ETag) headers.ETag = object.ETag;
      if (object.LastModified) headers['Last-Modified'] = object.LastModified.toUTCString();
      if (object.ContentRange) headers['Content-Range'] = object.ContentRange;
      response.writeHead(object.ContentRange ? 206 : 200, headers);
      if (request.method === 'HEAD') response.end();
      else await pipeline(object.Body, response);
    } catch (error) {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      const status = error.$metadata?.httpStatusCode;
      response.writeHead(status === 404 ? 404 : status === 416 ? 416 : 503, { 'Cache-Control': 'no-store' });
      response.end();
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = JSON.parse(readFileSync(process.env.GATHER_RUNTIME_CONFIG, 'utf8')).assets;
  if (!config.accessKeyId || !config.secretAccessKey || !config.endpoint) {
    throw new Error('Gather assets require explicit locally projected storage credentials.');
  }
  const client = new S3Client({
    region: config.region,
    endpoint: config.endpoint,
    forcePathStyle: true,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    maxAttempts: 2,
  });
  const server = createGateway({ client, bucket: config.bucket, originSecret: config.originSecret });
  server.listen(8080, '0.0.0.0');
  process.on('SIGTERM', () => server.close(() => { client.destroy(); process.exit(0); }));
}
