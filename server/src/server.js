import express from 'express';
import cookieParser from 'cookie-parser';
import fs from 'node:fs/promises';
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
const INVITE_FILE = path.join(PUBLIC_DIR, 'invite.html');

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

        const editor = isEditor(req);
        res.json({ ...state, data: editor ? state.data : withoutInviteCodes(state.data), visibility, canEdit: editor });
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

/* ------------------------------------------------------------- invitations */
// Each guest the editor sends an invitation to carries a random inviteCode.
// /d/<code> is that one guest's invitation page, open to anyone holding the
// link whatever the list's visibility: it shows that guest's name and the
// event details, and nothing else from the list.
const INVITE_CODE = /^[A-Za-z0-9]{8,32}$/;

// A public reader of the whole list must not be able to open other guests'
// invitations from it.
function withoutInviteCodes(data) {
    if (!data || !Array.isArray(data.tables)) return data;
    return {
        ...data,
        tables: data.tables.map(t => ({
            ...t,
            guests: (t.guests || []).map(({ inviteCode, ...g }) => g) // eslint-disable-line no-unused-vars
        }))
    };
}

const INVITE_FIELDS = ['name1', 'name2', 'date', 'time', 'venue', 'address', 'mapUrl', 'message', 'host', 'template'];

function findInvitation(data, code) {
    for (const table of (data && data.tables) || []) {
        const guest = (table.guests || []).find(g => g.inviteCode === code);
        if (!guest) continue;
        const saved = (data.settings && data.settings.invitation) || {};
        const invitation = {};
        for (const f of INVITE_FIELDS) if (typeof saved[f] === 'string') invitation[f] = saved[f].slice(0, 600);
        invitation.animate = saved.animate !== false;
        invitation.showSeats = saved.showSeats !== false;
        invitation.showTable = saved.showTable === true;
        return {
            invitation,
            guest: {
                name: String(guest.name || ''),
                title: guest.title === 'bəy' || guest.title === 'xanım' ? guest.title : '',
                amount: Number(guest.amount) || 0
            },
            table: invitation.showTable ? String(table.name || '') : null
        };
    }
    return null;
}

const MONTHS_AZ = ['Yanvar', 'Fevral', 'Mart', 'Aprel', 'May', 'İyun', 'İyul', 'Avqust', 'Sentyabr', 'Oktyabr', 'Noyabr', 'Dekabr'];
const escAttr = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

// What WhatsApp and Telegram show in the link preview.
function linkPreview(found) {
    if (!found) return null;
    const inv = found.invitation;
    const couple = [inv.name1, inv.name2].filter(Boolean).join(' & ');
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(inv.date || '');
    const when = m ? `${Number(m[3])} ${MONTHS_AZ[Number(m[2]) - 1]} ${m[1]}${inv.time ? ', ' + inv.time : ''}` : '';
    const g = found.guest;
    let name = g.name.trim();
    if (name && g.title) name += ' ' + g.title;
    if (name && g.amount > 1 && !/ailəsi$/i.test(name)) name += ' və ailəsi';
    return {
        title: couple ? `${couple} — toy dəvətnaməsi` : 'Toy dəvətnaməsi',
        description: [name ? `Hörmətli ${name}` : '', when, inv.venue].filter(Boolean).join(' · ')
    };
}

let inviteHtmlCache = null;
async function inviteHtml() {
    if (inviteHtmlCache && process.env.NODE_ENV === 'production') return inviteHtmlCache;
    inviteHtmlCache = await fs.readFile(INVITE_FILE, 'utf8');
    return inviteHtmlCache;
}

app.get('/d/:code', async (req, res) => {
    try {
        const code = String(req.params.code || '');
        let found = null;
        if (INVITE_CODE.test(code)) found = findInvitation((await getState()).data, code);

        let html = await inviteHtml();
        const preview = linkPreview(found);
        if (preview) {
            html = html
                .replace('<title>Toy dəvətnaməsi</title>', `<title>${escAttr(preview.title)}</title>`)
                .replace('<meta property="og:title" content="Toy dəvətnaməsi">', `<meta property="og:title" content="${escAttr(preview.title)}">`)
                .replace('<meta property="og:description" content="Sizi toyumuza dəvət edirik.">', `<meta property="og:description" content="${escAttr(preview.description)}">`);
        }
        // JSON inside <script>: "<" escaped so a name cannot close the tag.
        const json = JSON.stringify(found).replace(/</g, '\u003c');
        html = html.replace('<!--INVITE_DATA-->', `<script id="invite-data" type="application/json">${json}</script>`);

        // Live: a moved guest, a corrected time, show up on the next open.
        res.set('Cache-Control', 'no-store');
        res.set('X-Robots-Tag', 'noindex, nofollow');
        res.status(found ? 200 : 404).type('html').send(html);
    } catch (err) {
        console.error('[api] GET /d/:code failed:', err.message);
        res.status(500).type('text').send('Dəvətnamə açılmadı.');
    }
});

/* --------------------------------------------------------------------- app */
app.get('/', (req, res) => res.sendFile(INDEX_FILE));
app.get('/index.html', (req, res) => res.sendFile(INDEX_FILE));
app.get('/invite.html', (req, res) => res.sendFile(INVITE_FILE));
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
