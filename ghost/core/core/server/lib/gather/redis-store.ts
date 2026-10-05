import {createCipheriv, createDecipheriv, randomBytes} from 'node:crypto';

export interface RedisClient {
    eval(script: string, keys: number, ...args: Array<string | number>): Promise<unknown>;
    get(key: string): Promise<string | null>;
    set(key: string, value: string, ...args: Array<string | number>): Promise<unknown>;
    del(...keys: string[]): Promise<unknown>;
}
const TOKEN = /^[a-f0-9]{64}$/;

// Cookie-bearing records are authenticated/encrypted before persistence. The
// sealing key is projected separately from Redis credentials and never public.
export class SealedRedisStore {
    private readonly key: Buffer;
    private readonly redis: RedisClient;
    private readonly prefix: string;
    private readonly maxRecords: number;
    private readonly now: () => number;
    constructor(redis: RedisClient, prefix: string, secret: string, maxRecords = 1000, now = Date.now) {
        if (!/^[a-f0-9]{64}$/.test(secret) || !/^[a-z0-9:{}_.-]{1,200}$/.test(prefix)) {
            throw new Error('Invalid site session configuration');
        }
        this.key = Buffer.from(secret, 'hex');
        this.redis = redis;
        this.prefix = prefix;
        this.maxRecords = maxRecords;
        this.now = now;
    }
    private recordKey(token: string) {
        if (!TOKEN.test(token)) throw new Error('Invalid session token');
        return `${this.prefix}:record:${token}`;
    }
    private seal(value: unknown): string {
        const iv = randomBytes(12);
        const cipher = createCipheriv('aes-256-gcm', this.key, iv);
        cipher.setAAD(Buffer.from(this.prefix));
        const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
        return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64');
    }
    private open(record: string) {
        const bytes = Buffer.from(record, 'base64');
        const cipher = createDecipheriv('aes-256-gcm', this.key, bytes.subarray(0, 12));
        cipher.setAAD(Buffer.from(this.prefix));
        cipher.setAuthTag(bytes.subarray(12, 28));
        return JSON.parse(Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString());
    }
    async reserve(token: string, expiresAt: number): Promise<boolean> {
        const ttl = expiresAt - this.now();
        if (ttl <= 0) return false;
        const result = await this.redis.eval(`
            redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
            if redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[4]) then return 0 end
            if redis.call('SET', KEYS[2], ARGV[5], 'PX', ARGV[3], 'NX') == false then return 0 end
            redis.call('ZADD', KEYS[1], ARGV[2], ARGV[6])
            local latest = redis.call('ZREVRANGE', KEYS[1], 0, 0, 'WITHSCORES')
            redis.call('PEXPIRE', KEYS[1], tonumber(latest[2]) - tonumber(ARGV[1]))
            return 1`, 2, `${this.prefix}:pending`, this.recordKey(token),
        this.now(), expiresAt, ttl, this.maxRecords, this.seal({expiresAt}), token);
        return Number(result) === 1;
    }
    async put(token: string, value: {expiresAt: number} & Record<string, unknown>) {
        const ttl = value.expiresAt - this.now();
        if (ttl <= 0) throw new Error('Expired session');
        const updated = await this.redis.set(this.recordKey(token), this.seal(value), 'PX', ttl, 'XX');
        if (!updated) throw new Error('Session reservation expired');
    }
    async get(token: string) {
        const record = await this.redis.get(this.recordKey(token));
        return record ? this.open(record) : null;
    }
    async consume(token: string) {
        const record = await this.redis.eval(`
            local value = redis.call('GET', KEYS[1])
            redis.call('DEL', KEYS[1])
            redis.call('ZREM', KEYS[2], ARGV[1])
            return value`, 2, this.recordKey(token), `${this.prefix}:pending`, token);
        return typeof record === 'string' ? this.open(record) : null;
    }
    async delete(token: string | null) {
        if (token) await this.consume(token);
    }
}
