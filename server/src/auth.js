// One shared password, two access levels: editor and anonymous.
//
// There is no user table and no roles, because the app only ever needs to know
// "may this caller write?". Anonymous visitors may read, filter and print.
//
// The password is never stored in plaintext anywhere: EDITOR_PASSWORD_HASH
// holds a scrypt hash produced by `npm run hash-password`, which is run
// locally so the plaintext never leaves the machine that chose it.

import crypto from 'node:crypto';

const COOKIE_NAME = 'tp_session';
const SESSION_HOURS = Number(process.env.SESSION_HOURS || 24 * 14);

const SECRET = process.env.SESSION_SECRET || '';
const PASSWORD_HASH = process.env.EDITOR_PASSWORD_HASH || '';

if (!SECRET || SECRET.length < 32) {
    throw new Error('SESSION_SECRET must be set and at least 32 characters. See .env.example.');
}
if (!PASSWORD_HASH) {
    throw new Error('EDITOR_PASSWORD_HASH is not set. Generate one with: npm run hash-password');
}

/** scrypt hash, formatted as scrypt:N:r:p:salt:key (all base64url).
 *  ':' rather than '$' on purpose - '$' is variable interpolation to Docker
 *  Compose, to the shell, and to envsubst, so a '$' hash gets silently
 *  mangled in exactly the places this value has to travel through. */
export function hashPassword(plain, saltBytes = 16) {
    const N = 16384, r = 8, p = 1, keyLen = 32;
    const salt = crypto.randomBytes(saltBytes);
    const key = crypto.scryptSync(plain, salt, keyLen, { N, r, p, maxmem: 64 * 1024 * 1024 });
    return ['scrypt', N, r, p, salt.toString('base64url'), key.toString('base64url')].join(':');
}

function verifyPassword(plain, stored) {
    try {
        // Accept legacy '$'-separated hashes as well as the current ':' form.
        const raw = String(stored).trim();
        const [scheme, N, r, p, saltB64, keyB64] = raw.split(raw.includes(':') ? ':' : '$');
        if (scheme !== 'scrypt') return false;
        const salt = Buffer.from(saltB64, 'base64url');
        const expected = Buffer.from(keyB64, 'base64url');
        const actual = crypto.scryptSync(plain, salt, expected.length, {
            N: Number(N), r: Number(r), p: Number(p), maxmem: 64 * 1024 * 1024
        });
        // Constant time: a length mismatch alone must not leak through timing.
        if (actual.length !== expected.length) return false;
        return crypto.timingSafeEqual(actual, expected);
    } catch {
        return false;
    }
}

function sign(value) {
    return crypto.createHmac('sha256', SECRET).update(value).digest('base64url');
}

function makeToken() {
    const payload = Buffer.from(JSON.stringify({
        exp: Date.now() + SESSION_HOURS * 3600 * 1000
    })).toString('base64url');
    return payload + '.' + sign(payload);
}

function readToken(token) {
    if (typeof token !== 'string' || !token.includes('.')) return null;
    const [payload, signature] = token.split('.');
    const expected = sign(payload);
    // Compare as buffers of equal length, or timingSafeEqual throws.
    const a = Buffer.from(signature || '', 'utf8');
    const b = Buffer.from(expected, 'utf8');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    try {
        const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
        if (!data || typeof data.exp !== 'number' || Date.now() > data.exp) return null;
        return data;
    } catch {
        return null;
    }
}

export function isEditor(req) {
    return readToken(req.cookies?.[COOKIE_NAME]) !== null;
}

export function login(req, res, password) {
    if (typeof password !== 'string' || !verifyPassword(password, PASSWORD_HASH)) return false;
    res.cookie(COOKIE_NAME, makeToken(), {
        httpOnly: true,
        sameSite: 'lax',
        // Secure only behind TLS; over plain http on Tailscale the cookie would
        // otherwise never be stored.
        secure: process.env.COOKIE_SECURE === 'true',
        maxAge: SESSION_HOURS * 3600 * 1000,
        path: '/'
    });
    return true;
}

export function logout(res) {
    res.clearCookie(COOKIE_NAME, { path: '/' });
}

/** Route guard for anything that writes. */
export function requireEditor(req, res, next) {
    if (isEditor(req)) return next();
    res.status(401).json({ error: 'unauthorised', message: 'Dəyişiklik üçün daxil olun.' });
}

/** Crude fixed-window limiter, enough to stop password guessing on one box. */
export function makeRateLimiter({ windowMs = 60_000, max = 10 } = {}) {
    const hits = new Map();
    return function rateLimit(req, res, next) {
        const key = req.ip || 'unknown';
        const now = Date.now();
        const entry = hits.get(key);
        if (!entry || now > entry.resetAt) {
            hits.set(key, { count: 1, resetAt: now + windowMs });
            return next();
        }
        entry.count += 1;
        if (entry.count > max) {
            res.status(429).json({ error: 'too_many_requests', message: 'Çox cəhd. Bir az gözləyin.' });
            return;
        }
        next();
        // Keep the map from growing without bound on a long-lived process.
        if (hits.size > 5000) {
            for (const [k, v] of hits) if (now > v.resetAt) hits.delete(k);
        }
    };
}
