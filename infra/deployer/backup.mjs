/** Encrypted predeployment backup; bounded plaintext workspace is removed on exit. */
import {createReadStream} from 'node:fs';
import {mkdtemp, readFile, writeFile, mkdir, rm, stat, statfs} from 'node:fs/promises';
import {join} from 'node:path';
import {execFile, spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {createRequire} from 'node:module';
import {randomUUID, createHash} from 'node:crypto';
import {pipeline} from 'node:stream/promises';
import {safeBackupKey} from './backup-boundary.mjs';
const exec = promisify(execFile);
const config = JSON.parse(await readFile(process.argv[2], 'utf8'));
const require = createRequire(new URL('../../ghost/core/package.json', import.meta.url));
const {S3Client, ListObjectsV2Command, GetObjectCommand, PutObjectCommand} = require('@aws-sdk/client-s3');
const {Client: PostgreSQL} = require('pg');
const backup = config.backup;
const client = new S3Client({region: backup.region, endpoint: backup.endpoint, forcePathStyle: true,
    requestChecksumCalculation: 'WHEN_REQUIRED', credentials: {accessKeyId: backup.accessKeyId, secretAccessKey: backup.secretAccessKey}});
await mkdir(config.backupDirectory, {recursive: true, mode: 0o700});
const space = await statfs(config.backupDirectory);
if (space.bavail * space.bsize < 20 * 1024 ** 3) throw new Error('Backup disk reserve below 20 GiB');
const work = await mkdtemp(join(config.backupDirectory, '.snapshot-'));
let snapshot;
try {
    const db = config.production.tenancyOperatorDatabase || config.production.database;
    snapshot = new PostgreSQL({...db, connectionTimeoutMillis: 10000});
    await snapshot.connect();
    await snapshot.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const {rows: [{id: snapshotId}]} = await snapshot.query('SELECT pg_export_snapshot() AS id');
    const tenancy = await snapshot.query("SELECT to_regclass('gather_tenancy_state') IS NOT NULL AS installed");
    let restore;
    if (tenancy.rows[0].installed) {
        const state = (await snapshot.query("SELECT * FROM gather_tenancy_state WHERE key='isolation'")).rows[0];
        if (state) {
            const owner = await snapshot.query(`SELECT current_user AS login, pg_get_userbyid(p.proowner) AS owner
                FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                WHERE n.nspname=current_schema() AND p.proname='gather_ensure_runtime_role'`);
            if (owner.rows.length !== 1 || owner.rows[0].login !== owner.rows[0].owner) throw new Error('Shared backup requires the full migration identity');
            const control = await snapshot.query(`SELECT pg_get_userbyid(role) AS name FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid
                JOIN pg_namespace n ON n.oid=c.relnamespace, unnest(p.polroles) role
                WHERE n.nspname=current_schema() AND c.relname='gather_site_staff' AND p.polname='gather_staff_control'`);
            if (control.rows.length !== 1) throw new Error('Shared backup control policy inventory differs');
            const tables = JSON.parse(await readFile(new URL('../../ghost/core/core/server/lib/gather/tenant-tables.json', import.meta.url), 'utf8'));
            const counts = {};
            for (const table of tables) {
                if (!/^[a-z_]+$/.test(table)) throw new Error('Invalid audited backup table');
                counts[table] = (await snapshot.query('SELECT count(*)::text AS count FROM "' + table + '"')).rows[0].count;
            }
            restore = {schemaVersion: 1, manifestHash: state.manifest_hash, legacySiteId: state.legacy_site_id,
                migrationOwner: owner.rows[0].owner, controlRole: control.rows[0].name, counts,
                sites: (await snapshot.query('SELECT id, status FROM gather_sites ORDER BY id')).rows};
        }
    }
    const ca = join(work, 'database-ca.crt'); await writeFile(ca, db.ssl.ca, {mode: 0o600});
    const {stdout: dump} = await exec(config.pgDump, ['--format=custom', '--no-owner', '--no-privileges', '--snapshot=' + snapshotId,
        ...(restore ? ['--enable-row-security', '--inserts'] : [])], {
        encoding: 'buffer', maxBuffer: 1024 ** 3, timeout: 300000,
        env: {...process.env, PGHOST: db.ssl.servername, PGHOSTADDR: db.host, PGPORT: String(db.port),
            PGDATABASE: db.database, PGUSER: db.user, PGPASSWORD: db.password, PGSSLMODE: 'verify-full', PGSSLROOTCERT: ca}
    });
    await snapshot.query('COMMIT');
    await snapshot.end(); snapshot = null;
    await rm(ca);
    await writeFile(join(work, 'database.dump'), dump, {mode: 0o600});
    const manifest = {databaseSha256: createHash('sha256').update(dump).digest('hex'), objects: [], ...(restore ? {tenancyRestore: restore} : {})};
    let continuation;
    let bytes = dump.length;
    do {
        const page = await client.send(new ListObjectsV2Command({Bucket: config.production.storage.bucket, ContinuationToken: continuation}));
        for (const object of page.Contents || []) {
            const key = object.Key;
            if (!safeBackupKey(key)) throw new Error('Unsafe backup object key');
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
} finally {if (snapshot) await snapshot.end(); await rm(work, {recursive: true, force: true}); client.destroy();}
