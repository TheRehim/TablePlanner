// End-to-end smoke test against a running server.
//
//   BASE=http://localhost:3000 PASSWORD=... node scripts/smoke.mjs
//
// Exercises auth, the read path, optimistic concurrency and the read-only
// boundary. Exits non-zero on the first failure.

const BASE = process.env.BASE || 'http://localhost:3000';
const PASSWORD = process.env.PASSWORD || '';
const DB = process.env.EXPECT_DB !== 'false';   // set false when no Postgres

let failures = 0;
const results = [];
function ok(name, pass, detail) {
    results.push(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  [' + detail + ']' : ''}`);
    if (!pass) failures++;
}

let cookie = '';
async function call(method, path, body, useCookie = true) {
    const res = await fetch(BASE + path, {
        method,
        headers: {
            'content-type': 'application/json',
            ...(useCookie && cookie ? { cookie } : {})
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'manual'
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie && useCookie) cookie = setCookie.split(';')[0];
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* html or empty */ }
    return { status: res.status, json, text };
}

// Open GET /api/events anonymously and collect every `state` event it sends.
async function listen() {
    const controller = new AbortController();
    const res = await fetch(BASE + '/api/events', { signal: controller.signal });
    const events = [];
    (async () => {
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        try {
            for (;;) {
                const { value, done } = await reader.read();
                if (done) break;
                buf += decoder.decode(value, { stream: true });
                let i;
                while ((i = buf.indexOf('\n\n')) >= 0) {
                    const m = buf.slice(0, i).match(/^data: (.*)$/m);
                    buf = buf.slice(i + 2);
                    if (m) events.push(JSON.parse(m[1]));
                }
            }
        } catch { /* aborted */ }
    })();
    return { res, events, close: () => controller.abort() };
}
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

/* ------------------------------------------------------------- always on */
let r = await call('GET', '/healthz', undefined, false);
ok('GET /healthz is 200', r.status === 200 && r.json?.ok === true, 'status ' + r.status);

r = await call('GET', '/', undefined, false);
ok('GET / serves the app', r.status === 200 && /Toy Masa/.test(r.text), 'status ' + r.status);

r = await call('GET', '/api/me', undefined, false);
ok('anonymous cannot edit', r.status === 200 && r.json?.canEdit === false, JSON.stringify(r.json));

r = await call('GET', '/nope', undefined, false);
ok('unknown route is 404 json', r.status === 404 && r.json?.error === 'not_found');

/* -------------------------------------------------------- write is closed */
r = await call('PUT', '/api/state', { data: { tables: [], guestTypes: [] }, version: 0 }, false);
ok('anonymous PUT is rejected', r.status === 401 && r.json?.error === 'unauthorised',
   'status ' + r.status);

/* ----------------------------------------------------------------- login */
r = await call('POST', '/api/login', { password: 'definitely-not-the-password' }, false);
ok('wrong password rejected', r.status === 401 && r.json?.error === 'bad_password',
   'status ' + r.status);

if (PASSWORD) {
    r = await call('POST', '/api/login', { password: PASSWORD });
    ok('correct password accepted', r.status === 200 && r.json?.canEdit === true, 'status ' + r.status);
    ok('session cookie issued', /tp_session=/.test(cookie), cookie.slice(0, 24) + '...');

    r = await call('GET', '/api/me');
    ok('session recognised', r.json?.canEdit === true);

    // A tampered cookie must not be accepted.
    const good = cookie;
    cookie = good.replace(/.$/, c => (c === 'A' ? 'B' : 'A'));
    r = await call('GET', '/api/me');
    ok('tampered cookie rejected', r.json?.canEdit === false, JSON.stringify(r.json));
    cookie = good;
} else {
    results.push('SKIP  login tests (set PASSWORD=...)');
}

/* ------------------------------------------------------------ db-backed */
if (DB) {
    // Visibility decides whether an ANONYMOUS caller may read at all.
    const anon = await call('GET', '/api/state', undefined, false);
    const visibility = anon.status === 401 ? 'private' : (anon.json?.visibility || 'public');
    results.push(`NOTE  list is currently ${visibility}`);

    if (visibility === 'private') {
        ok('private: anonymous read refused', anon.status === 401 && anon.json?.error === 'private',
           'status ' + anon.status);
    } else {
        ok('public: anonymous read allowed', anon.status === 200 && Array.isArray(anon.json?.data?.tables),
           'status ' + anon.status);
    }

    if (PASSWORD) {
        // Read as the editor, who may always see it.
        r = await call('GET', '/api/state');
        ok('editor read is 200', r.status === 200 && typeof r.json?.version === 'number', 'status ' + r.status);
        ok('state has the expected shape',
           Array.isArray(r.json?.data?.tables) && Array.isArray(r.json?.data?.guestTypes),
           JSON.stringify(r.json?.data)?.slice(0, 60));

        const current = r.json;
        const next = {
            ...current.data,
            tables: [{ id: 1, name: 'Smoke Masa', capacity: 8, guests: [] }]
        };
        // Keep whatever visibility the list already had.
        next.settings = current.data.settings || { visibility: 'private' };

        // Live updates: an anonymous page must hear about the write, and
        // must hear only the version - never the guest data itself.
        const live = await listen();
        ok('live stream opens', live.res.status === 200 &&
           /text\/event-stream/.test(live.res.headers.get('content-type') || ''),
           'status ' + live.res.status);
        await pause(200);
        ok('live stream sends the current version on connect',
           live.events[0]?.version === current.version, JSON.stringify(live.events[0]));

        r = await call('PUT', '/api/state', { data: next, version: current.version, action: 'smoke' });
        ok('editor PUT accepted', r.status === 200 && r.json?.ok === true, 'status ' + r.status);
        const newVersion = r.json?.version;
        ok('version incremented', newVersion === current.version + 1,
           `${current.version} -> ${newVersion}`);

        await pause(300);
        const announced = live.events.find(e => e.version === newVersion);
        ok('write is pushed live', !!announced, JSON.stringify(live.events));
        ok('live event carries no guest data',
           !!announced && Object.keys(announced).sort().join() === 'version,visibility',
           JSON.stringify(announced));
        live.close();

        // Writing again with the OLD version must conflict, not clobber.
        r = await call('PUT', '/api/state', { data: next, version: current.version, action: 'stale' });
        ok('stale write gets 409', r.status === 409 && r.json?.error === 'conflict', 'status ' + r.status);
        ok('409 reports the current version', r.json?.currentVersion === newVersion,
           JSON.stringify(r.json));

        r = await call('GET', '/api/state');
        ok('write persisted', r.json?.data?.tables?.[0]?.name === 'Smoke Masa',
           JSON.stringify(r.json?.data?.tables?.[0]));

        r = await call('PUT', '/api/state', { data: { nope: true }, version: r.json.version });
        ok('malformed payload rejected', r.status === 400, 'status ' + r.status);

        r = await call('GET', '/api/revisions');
        ok('revision history recorded', r.status === 200 && r.json?.revisions?.length > 0,
           (r.json?.revisions?.length || 0) + ' revisions');

        /* ---- visibility switching, both directions ---- */
        let st = (await call('GET', '/api/state')).json;

        const goPublic = { ...st.data, settings: { visibility: 'public' } };
        r = await call('PUT', '/api/state', { data: goPublic, version: st.version, action: 'public' });
        ok('editor can open the list', r.status === 200, 'status ' + r.status);
        r = await call('GET', '/api/state', undefined, false);
        ok('public: anonymous CAN now read', r.status === 200, 'status ' + r.status);

        st = (await call('GET', '/api/state')).json;
        const goPrivate = { ...st.data, settings: { visibility: 'private' } };
        r = await call('PUT', '/api/state', { data: goPrivate, version: st.version, action: 'private' });
        ok('editor can close the list', r.status === 200, 'status ' + r.status);
        r = await call('GET', '/api/state', undefined, false);
        ok('private: anonymous refused again', r.status === 401 && r.json?.error === 'private',
           'status ' + r.status);

        // A write that omits settings must not silently re-open the list.
        st = (await call('GET', '/api/state')).json;
        const noSettings = { guestTypes: st.data.guestTypes, tables: st.data.tables, notes: st.data.notes };
        r = await call('PUT', '/api/state', { data: noSettings, version: st.version, action: 'no-settings' });
        ok('settings-less write accepted', r.status === 200, 'status ' + r.status);
        r = await call('GET', '/api/state', undefined, false);
        ok('still private after settings-less write (fails closed)',
           r.status === 401, 'status ' + r.status);

        // Anonymous must never be able to write, in either mode.
        r = await call('PUT', '/api/state', { data: noSettings, version: 999 }, false);
        ok('anonymous write still refused', r.status === 401, 'status ' + r.status);
    }
} else {
    results.push('SKIP  database tests (EXPECT_DB=false)');
    r = await call('GET', '/readyz', undefined, false);
    ok('readyz reports db down without a database', r.status === 503, 'status ' + r.status);
}

console.log(results.join('\n'));
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
