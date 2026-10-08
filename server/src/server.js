import express from 'express';
import cookieParser from 'cookie-parser';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { getState, putState, ping, listRevisions, getRevision, pool, visibilityOf } from './db.js';
import { isEditor, login, logout, requireEditor, makeRateLimiter } from './auth.js';
import { eventsHandler, broadcast, noteState, closeAll } from './live.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// The app itself is the single index.html at the repo root; in the container it
// is copied to /app/public. Only that file and its icon are served - the repo
// is not exposed as a static directory.
const PUBLIC_DIR = process.env.PUBLIC_DIR || path.resolve(__dirname, '../..');
const INDEX_FILE = path.join(PUBLIC_DIR, 'index.html');
const FAVICON_FILE = path.join(PUBLIC_DIR, 'favicon.ico');

const PORT = Number(process.env.PORT || 3000);

const app = express();
app.disable('x-powered-by');
// Behind Traefik; needed for req.ip to be the real client in the rate limiter.
app.set('trust proxy', Number(process.env.TRUST_PROXY_HOPS || 1));

app.use(cookieParser());
app.use(express.json({ limit: process.env.BODY_LIMIT || '2mb' }));

/* ------------------------------------------------------------------ health */
// Liveness must not touch the database: a DB blip should not get the pod killed.
app.get('/healthz', (req, res) => res.json({ ok: true }));

app.get('/readyz', async (req, res) => {
    try {
        await ping();
        res.json({ ok: true, db: 'up' });
    } catch (err) {
        res.status(503).json({ ok: false, db: 'down', message: err.message });
    }
});

/* -------------------------------------------------------------------- auth */
const loginLimiter = makeRateLimiter({ windowMs: 60_000, max: 10 });

app.post('/api/login', loginLimiter, (req, res) => {
    const ok = login(req, res, req.body?.password);
    if (!ok) return res.status(401).json({ error: 'bad_password', message: 'Şifrə yanlışdır.' });
    res.json({ ok: true, canEdit: true });
});

app.post('/api/logout', (req, res) => {
    logout(res);
    res.json({ ok: true, canEdit: false });
});

app.get('/api/me', async (req, res) => {
    let visibility = 'private';
    try { visibility = visibilityOf((await getState()).data); } catch { /* fall back to closed */ }
    res.json({ canEdit: isEditor(req), visibility });
});

/* ------------------------------------------------------------------- state */
app.get('/api/state', async (req, res) => {
    try {
        const state = await getState();
        const visibility = visibilityOf(state.data);
        noteState(state.version, visibility);

        // Private means the DATA is refused, not merely hidden in the page.
        // Anyone can edit the markup; only this can actually keep the guest
        // list from being read.
        if (visibility === 'private' && !isEditor(req)) {
            return res.status(401).json({
                error: 'private',
                visibility: 'private',
                message: 'Bu siyahı bağlıdır. Baxmaq üçün daxil olun.'
            });
        }

        res.json({ ...state, visibility, canEdit: isEditor(req) });
    } catch (err) {
        console.error('[api] GET /api/state failed:', err.message);
        res.status(500).json({ error: 'server_error', message: 'Məlumat oxunmadı.' });
    }
});

app.put('/api/state', requireEditor, async (req, res) => {
    const { data, version, action } = req.body || {};

    if (!data || typeof data !== 'object' || Array.isArray(data)) {
        return res.status(400).json({ error: 'bad_request', message: '"data" obyekt olmalıdır.' });
    }
    if (!Array.isArray(data.tables) || !Array.isArray(data.guestTypes)) {
        return res.status(400).json({
            error: 'bad_request',
            message: '"tables" və "guestTypes" massiv olmalıdır.'
        });
    }
    if (!Number.isFinite(Number(version))) {
        return res.status(400).json({ error: 'bad_request', message: '"version" rəqəm olmalıdır.' });
    }

    try {
        // Carry settings forward when a client omits them, so an older page or
        // a hand-made payload cannot silently flip the list back to public.
        if (!data.settings || typeof data.settings !== 'object') {
            const current = await getState();
            data.settings = (current.data && current.data.settings) || { visibility: 'private' };
        }
        if (data.settings.visibility !== 'public') data.settings.visibility = 'private';

        const result = await putState(data, Number(version), String(action || 'update').slice(0, 40));
        if (!result.ok && result.conflict) {
            // Somebody else wrote first. Hand back the current version so the
            // client can re-fetch rather than clobber their change.
            return res.status(409).json({
                error: 'conflict',
                message: 'Məlumat başqa yerdə dəyişdirilib. Yeniləyin.',
                currentVersion: result.current
            });
        }
        res.json({ ok: true, version: result.version });
        // Every other open page re-fetches. Only the number goes out; each
        // page reads the data through GET /api/state and its access check.
        broadcast(result.version, visibilityOf(data));
    } catch (err) {
        console.error('[api] PUT /api/state failed:', err.message);
        res.status(500).json({ error: 'server_error', message: 'Yadda saxlanmadı.' });
    }
});

/* -------------------------------------------------------------------- live */
// Open to anonymous callers on purpose: a locked page must learn when the list
// is opened. It only ever carries { version, visibility } - see live.js.
app.get('/api/events', eventsHandler(async () => {
    const state = await getState();
    return { version: state.version, visibility: visibilityOf(state.data) };
}));

/* --------------------------------------------------------------- revisions */
app.get('/api/revisions', requireEditor, async (req, res) => {
    try {
        res.json({ revisions: await listRevisions(req.query.limit) });
    } catch (err) {
        console.error('[api] GET /api/revisions failed:', err.message);
        res.status(500).json({ error: 'server_error' });
    }
});

app.get('/api/revisions/:id', requireEditor, async (req, res) => {
    try {
        const revision = await getRevision(Number(req.params.id));
        if (!revision) return res.status(404).json({ error: 'not_found' });
        res.json(revision);
    } catch (err) {
        console.error('[api] GET /api/revisions/:id failed:', err.message);
        res.status(500).json({ error: 'server_error' });
    }
});

/* --------------------------------------------------------------------- app */
app.get('/', (req, res) => res.sendFile(INDEX_FILE));
app.get('/index.html', (req, res) => res.sendFile(INDEX_FILE));
app.get('/favicon.ico', (req, res) => res.sendFile(FAVICON_FILE, { maxAge: '7d' }));

app.use((req, res) => res.status(404).json({ error: 'not_found' }));

// Express 4 needs the four-arg signature to treat this as an error handler.
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
    console.error('[api] unhandled:', err.message);
    res.status(500).json({ error: 'server_error' });
});

const server = app.listen(PORT, () => {
    console.log(`[tableplanner] listening on :${PORT}`);
    console.log(`[tableplanner] serving ${INDEX_FILE}`);
});

/* Graceful shutdown so Kubernetes rolling updates do not cut live requests. */
for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, () => {
        console.log(`[tableplanner] ${signal} received, shutting down`);
        closeAll();
        server.close(async () => {
            try { await pool.end(); } catch { /* already closed */ }
            process.exit(0);
        });
        // Do not hang forever if a connection refuses to drain.
        setTimeout(() => process.exit(1), 10_000).unref();
    });
}
