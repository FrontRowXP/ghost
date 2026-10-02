import {timingSafeEqual} from 'node:crypto';
import errors from '@tryghost/errors';
import type {RequestHandler} from 'express';

/** Validate the locally projected CDN credential without another network hop. */
export function gatherOrigin({secret, required = false}: {secret?: string; required?: boolean}): RequestHandler {
    if (!secret && !required) {
        return (_req, _res, next) => next();
    }
    if (typeof secret !== 'string' || Buffer.byteLength(secret) < 48) {
        throw new errors.IncorrectUsageError({message: 'Gather hosted runtime requires a strong origin credential'});
    }
    const expected = Buffer.from(secret);
    return (req, res, next) => {
        const header = req.headers['x-gather-origin-key'];
        const supplied = Buffer.from(typeof header === 'string' ? header : '');
        if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
            res.setHeader('Cache-Control', 'no-store');
            res.statusCode = 403;
            res.end();
            return;
        }
        next();
    };
}
