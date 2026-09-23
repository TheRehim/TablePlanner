// Round-trips Azerbaijani text through the API and Postgres to prove the
// encoding survives. Run against a live server:
//   BASE=http://localhost:3000 PASSWORD=... node scripts/utf8check.mjs
const BASE = process.env.BASE || 'http://localhost:3000';
const PASSWORD = process.env.PASSWORD || '';

const SAMPLE = {
    guest: 'Dayanıqlı Qonaq — Əliyeva İlhamə',
    note: 'Xatırlatmalar: çiçək, tort, şüşə',
    type: 'İş yoldaşı',
    masa: 'Əsas Masa №1'
};

let cookie = '';
async function call(method, path, body) {
    const res = await fetch(BASE + path, {
        method,
        headers: { 'content-type': 'application/json; charset=utf-8', ...(cookie ? { cookie } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body)
    });
    const sc = res.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    return { status: res.status, json: await res.json().catch(() => null) };
}

const login = await call('POST', '/api/login', { password: PASSWORD });
if (login.status !== 200) { console.error('login failed:', login.status); process.exit(1); }

const before = await call('GET', '/api/state');
const payload = {
    guestTypes: ['Dost', SAMPLE.type],
    tables: [{ id: 1, name: SAMPLE.masa, capacity: 16,
               guests: [{ id: 2, name: SAMPLE.guest, type: SAMPLE.type, amount: 4 }] }],
    notes: [{ id: 3, title: SAMPLE.note, items: [{ id: 4, name: 'Şəkil çək', type: '', amount: 1 }] }],
    settings: { visibility: 'private' }
};

const put = await call('PUT', '/api/state', { data: payload, version: before.json.version, action: 'utf8' });
if (put.status !== 200) { console.error('write failed:', put.status, put.json); process.exit(1); }

const after = await call('GET', '/api/state');
const d = after.json.data;

const checks = [
    ['masa name',  d.tables[0].name,               SAMPLE.masa],
    ['guest name', d.tables[0].guests[0].name,     SAMPLE.guest],
    ['guest type', d.tables[0].guests[0].type,     SAMPLE.type],
    ['note title', d.notes[0].title,               SAMPLE.note],
    ['note row',   d.notes[0].items[0].name,       'Şəkil çək'],
    ['type list',  d.guestTypes[1],                SAMPLE.type]
];

let bad = 0;
for (const [label, got, want] of checks) {
    const ok = got === want;
    if (!ok) bad++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(11)} ${JSON.stringify(got)}`);
    if (!ok) console.log(`      expected ${JSON.stringify(want)}`);
}
console.log(bad === 0
    ? '\nALL PASS - Azerbaijani text round-trips through the API and Postgres intact.'
    : `\n${bad} FAILURE(S) - text is being mangled.`);
process.exit(bad === 0 ? 0 : 1);
