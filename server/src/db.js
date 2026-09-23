// Storage for the whole planner state as one JSONB document.
//
// There is effectively one editor, so the entire dataset moves as a single
// row. That is what makes moveGuest / switchGuests safe: they touch two masas
// at once, which under per-entity endpoints would need a transaction, but as a
// single-document write the problem does not arise.
//
// `version` still exists so a stale tab gets a 409 instead of silently wiping
// someone else's work.

import pg from 'pg';

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is not set. Copy .env.example to .env and fill it in.');
}

// DATABASE_URL=memory: runs the whole app with no Postgres at all. Useful for
// a demo or a quick look, and it is what lets the API be exercised without
// infrastructure. State lives in the process and dies with it - the log says
// so loudly, because this must never be mistaken for the real thing.
export const MEMORY_MODE = /^memory:/i.test(process.env.DATABASE_URL);

if (MEMORY_MODE) {
    console.warn('[db] MEMORY MODE - nothing is persisted, all data is lost on restart.');
}

const memory = { data: null, version: 0, updatedAt: null, revisions: [] };

export const pool = MEMORY_MODE ? { end: async () => {}, on: () => {} } : new Pool({
    connectionString: process.env.DATABASE_URL,
    // A single small app on a shared, memory-constrained box: keep the pool tiny.
    max: Number(process.env.PG_POOL_MAX || 4),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000
});

if (!MEMORY_MODE) {
    pool.on('error', err => {
        // A broken idle client must not take the process down.
        console.error('[db] idle client error:', err.message);
    });
}

export const EMPTY_STATE = {
    guestTypes: ['Dost'],
    tables: [],
    notes: [],
    // Closed by default. The guest list holds real names, so the safe default
    // is private and opened deliberately, not the other way round.
    settings: { visibility: 'private' }
};

export function visibilityOf(data) {
    return data && data.settings && data.settings.visibility === 'public' ? 'public' : 'private';
}

// Readiness check. `SELECT 1` succeeds against an empty database, which would
// let a pod report Ready while every read 500s because migrations never ran.
// Proving the table exists is what actually makes a broken deploy visible.
export async function ping() {
    if (MEMORY_MODE) return true;
    const { rows } = await pool.query("SELECT to_regclass('public.wedding_state') AS tbl");
    if (!rows[0].tbl) throw new Error('schema missing - migrations have not run');
    return true;
}

export async function getState() {
    if (MEMORY_MODE) {
        return memory.data === null
            ? { data: EMPTY_STATE, version: 0, updatedAt: null }
            : { data: memory.data, version: memory.version, updatedAt: memory.updatedAt };
    }
    const { rows } = await pool.query(
        'SELECT data, version, updated_at FROM wedding_state WHERE id = 1'
    );
    if (rows.length === 0) {
        // First boot before the seed row exists.
        return { data: EMPTY_STATE, version: 0, updatedAt: null };
    }
    return { data: rows[0].data, version: rows[0].version, updatedAt: rows[0].updated_at };
}

/**
 * Replace the state, but only if it is still at `expectedVersion`.
 * Returns { ok: true, version } or { ok: false, conflict: true, current }.
 *
 * The state row and its revision are written in one transaction, so history
 * can never disagree with the current document.
 */
export async function putState(data, expectedVersion, action = 'update') {
    if (MEMORY_MODE) {
        if (memory.data !== null && Number(expectedVersion) !== Number(memory.version)) {
            return { ok: false, conflict: true, current: memory.version };
        }
        memory.data = data;
        memory.version = memory.version + 1;
        memory.updatedAt = new Date().toISOString();
        memory.revisions.unshift({
            id: memory.revisions.length + 1, data, action, created_at: memory.updatedAt
        });
        if (memory.revisions.length > 200) memory.revisions.length = 200;
        return { ok: true, version: memory.version };
    }
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const existing = await client.query(
            'SELECT version FROM wedding_state WHERE id = 1 FOR UPDATE'
        );

        if (existing.rows.length === 0) {
            // No seed row yet: accept the write and create it.
            const inserted = await client.query(
                `INSERT INTO wedding_state (id, data, version)
                 VALUES (1, $1, 1)
                 RETURNING version`,
                [data]
            );
            await client.query(
                'INSERT INTO wedding_revision (data, action) VALUES ($1, $2)',
                [data, action]
            );
            await client.query('COMMIT');
            return { ok: true, version: inserted.rows[0].version };
        }

        const current = existing.rows[0].version;
        if (Number(expectedVersion) !== Number(current)) {
            await client.query('ROLLBACK');
            return { ok: false, conflict: true, current };
        }

        const updated = await client.query(
            `UPDATE wedding_state
                SET data = $1, version = version + 1, updated_at = now()
              WHERE id = 1
             RETURNING version`,
            [data]
        );
        await client.query(
            'INSERT INTO wedding_revision (data, action) VALUES ($1, $2)',
            [data, action]
        );

        await client.query('COMMIT');
        return { ok: true, version: updated.rows[0].version };
    } catch (err) {
        try { await client.query('ROLLBACK'); } catch { /* connection already gone */ }
        throw err;
    } finally {
        client.release();
    }
}

export async function listRevisions(limit = 20) {
    if (MEMORY_MODE) {
        return memory.revisions.slice(0, Math.min(Math.max(Number(limit) || 20, 1), 100))
            .map(({ id, action, created_at }) => ({ id, action, created_at }));
    }
    const { rows } = await pool.query(
        `SELECT id, action, created_at
           FROM wedding_revision
          ORDER BY id DESC
          LIMIT $1`,
        [Math.min(Math.max(Number(limit) || 20, 1), 100)]
    );
    return rows;
}

export async function getRevision(id) {
    if (MEMORY_MODE) return memory.revisions.find(r => r.id === Number(id)) || null;
    const { rows } = await pool.query(
        'SELECT id, data, action, created_at FROM wedding_revision WHERE id = $1',
        [id]
    );
    return rows[0] || null;
}
