// Live updates over Server-Sent Events.
//
// Every open page keeps one GET /api/events stream. After a successful write
// the server pushes the new version number, and each page re-fetches
// /api/state itself. The stream never carries guest data: /api/state stays the
// one place that decides who may read the list, so a private list is exactly
// as closed as before. What an anonymous listener learns is the version number
// and the visibility, and /api/me already hands out the visibility.
//
// The broadcast is in-process. That is correct while the Deployment runs one
// replica with the Recreate strategy (it does - single writer, single row). A
// second replica would need Postgres LISTEN/NOTIFY here instead, or pages
// connected to one pod would miss writes made through the other.

const HEARTBEAT_MS = 25_000;    // under every proxy idle timeout in the path
const MAX_CLIENTS = Number(process.env.LIVE_MAX_CLIENTS || 500);
const MAX_PER_IP = Number(process.env.LIVE_MAX_PER_IP || 20);

const clients = new Set();
const perIp = new Map();

// Last known { version, visibility }. Seeded lazily from the database, then
// kept current by every write that goes through this process.
let latest = null;

export function noteState(version, visibility) {
    const v = Number(version) || 0;
    // A read that started before a write can finish after it; never step back.
    if (latest && v < latest.version) return;
    latest = { version: v, visibility };
}

function send(res, event) {
    res.write(`event: state\ndata: ${JSON.stringify(event)}\n\n`);
}

export function broadcast(version, visibility) {
    noteState(version, visibility);
    for (const res of clients) send(res, latest);
}

export function liveCount() {
    return clients.size;
}

/**
 * Express handler for GET /api/events. `loadLatest` is called only when no
 * write has been seen yet, and must resolve to { version, visibility }.
 */
export function eventsHandler(loadLatest) {
    return async (req, res) => {
        const ip = req.ip || 'unknown';
        const fromIp = perIp.get(ip) || 0;
        // Anyone can open this, so bound it: an open stream is a held socket.
        if (clients.size >= MAX_CLIENTS || fromIp >= MAX_PER_IP) {
            return res.status(503).json({ error: 'busy' });
        }

        try {
            if (!latest) {
                const first = await loadLatest();
                noteState(first.version, first.visibility);
            }
        } catch (err) {
            console.error('[live] could not read the current version:', err.message);
            return res.status(503).json({ error: 'db_down' });
        }

        res.writeHead(200, {
            'content-type': 'text/event-stream; charset=utf-8',
            'cache-control': 'no-cache, no-transform',
            connection: 'keep-alive',
            'x-accel-buffering': 'no'     // tell buffering proxies to stream
        });
        // The browser reconnects on its own; this is how long it waits.
        res.write('retry: 3000\n\n');
        // Always send the current version on (re)connect, so a page that was
        // offline or asleep catches up on whatever it missed.
        send(res, latest);

        clients.add(res);
        perIp.set(ip, fromIp + 1);
        req.socket.setKeepAlive(true);
        req.socket.setTimeout(0);

        const heartbeat = setInterval(() => res.write(': ping\n\n'), HEARTBEAT_MS);
        heartbeat.unref();

        req.on('close', () => {
            clearInterval(heartbeat);
            clients.delete(res);
            const left = (perIp.get(ip) || 1) - 1;
            if (left > 0) perIp.set(ip, left); else perIp.delete(ip);
        });
    };
}

// Streams never finish on their own, so server.close() would wait on them
// until the kill timeout. End them first; browsers reconnect to the new pod.
export function closeAll() {
    for (const res of clients) res.end();
    clients.clear();
    perIp.clear();
}
