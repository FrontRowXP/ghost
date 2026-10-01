/** Encrypted predeployment backup; bounded plaintext workspace is removed on exit. */
import {createReadStream} from 'node:fs';
import {mkdtemp, readFile, writeFile, mkdir, rm, stat, statfs} from 'node:fs/promises';
import {join} from 'node:path';
import {execFile, spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {createRequire} from 'node:module';
import {randomUUID, createHash} from 'node:crypto';
import {pipeline} from 'node:stream/promises';
const exec = promisify(execFile);
const config = JSON.parse(await readFile(process.argv[2], 'utf8'));
const require = createRequire(new URL('../../ghost/core/package.json', import.meta.url));
const {S3Client, ListObjectsV2Command, GetObjectCommand, PutObjectCommand} = require('@aws-sdk/client-s3');
const backup = config.backup;
const client = new S3Client({region: backup.region, endpoint: backup.endpoint, forcePathStyle: true,
    requestChecksumCalculation: 'WHEN_REQUIRED', credentials: {accessKeyId: backup.accessKeyId, secretAccessKey: backup.secretAccessKey}});
await mkdir(config.backupDirectory, {recursive: true, mode: 0o700});
const space = await statfs(config.backupDirectory);
if (space.bavail * space.bsize < 20 * 1024 ** 3) throw new Error('Backup disk reserve below 20 GiB');
const work = await mkdtemp(join(config.backupDirectory, '.snapshot-'));
try {
    const db = config.production.database;
    const ca = join(work, 'database-ca.crt'); await writeFile(ca, db.ssl.ca, {mode: 0o600});
    const {stdout: dump} = await exec(config.pgDump, ['--format=custom', '--no-owner', '--no-privileges'], {
        encoding: 'buffer', maxBuffer: 1024 ** 3, timeout: 300000,
        env: {...process.env, PGHOST: db.ssl.servername, PGHOSTADDR: db.host, PGPORT: String(db.port),
            PGDATABASE: db.database, PGUSER: db.user, PGPASSWORD: db.password, PGSSLMODE: 'verify-full', PGSSLROOTCERT: ca}
    });
    await rm(ca);
    await writeFile(join(work, 'database.dump'), dump, {mode: 0o600});
    const manifest = {databaseSha256: createHash('sha256').update(dump).digest('hex'), objects: []};
    let continuation;
    let bytes = dump.length;
    do {
        const page = await client.send(new ListObjectsV2Command({Bucket: config.production.storage.bucket, ContinuationToken: continuation}));
        for (const object of page.Contents || []) {
            const key = object.Key;
            if (!key.startsWith('content/') || key.split('/').some(part => ['..', '.'].includes(part)) || key.includes('\\')) throw new Error('Unsafe backup object key');
            bytes += object.Size;
            if (bytes > 2 * 1024 ** 3) throw new Error('Snapshot exceeds the configured 2 GiB bound');
            const destination = join(work, 'storage', key); await mkdir(join(destination, '..'), {recursive: true, mode: 0o700});
            const result = await client.send(new GetObjectCommand({Bucket: config.production.storage.bucket, Key: key}));
            const body = Buffer.from(await result.Body.transformToByteArray());
            await writeFile(destination, body, {mode: 0o600});
            manifest.objects.push({key, bytes: body.length, sha256: createHash('sha256').update(body).digest('hex')});
        }
        continuation = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (continuation);
    await writeFile(join(work, 'manifest.json'), JSON.stringify(manifest), {mode: 0o600});
    const tar = join(config.backupDirectory, `.archive-${randomUUID()}.tar.gz`);
    const name = `production-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}.tar.gz.gpg`;
    const cipher = join(config.backupDirectory, name);
    try {
        await exec('tar', ['-czf', tar, '-C', work, '.'], {timeout: 300000});
        await new Promise((resolve, reject) => {
            const child = spawn('gpg', ['--batch', '--yes', '--pinentry-mode', 'loopback', '--passphrase-fd', '3',
                '--symmetric', '--cipher-algo', 'AES256', '--output', cipher, tar], {stdio: ['ignore', 'ignore', 'ignore', 'pipe']});
            child.on('error', reject);
            child.on('close', code => code === 0 ? resolve() : reject(new Error('Backup encryption failed')));
            child.stdio[3].end(backup.passphrase);
        });
        const size = (await stat(cipher)).size;
        await client.send(new PutObjectCommand({Bucket: backup.bucket, Key: name, Body: createReadStream(cipher), ContentLength: size, ContentType: 'application/pgp-encrypted'}));
        const downloaded = await client.send(new GetObjectCommand({Bucket: backup.bucket, Key: name}));
        const hash = createHash('sha256'); await pipeline(downloaded.Body, hash);
        const local = createHash('sha256'); await pipeline(createReadStream(cipher), local);
        if (hash.digest('hex') !== local.digest('hex')) throw new Error('NAS backup verification failed');
        console.log('Encrypted production backup verified on NAS; protected second copy retained.', name);
    } finally {await rm(tar, {force: true});}
} finally {await rm(work, {recursive: true, force: true}); client.destroy();}
