# Handoff — deploying TablePlanner on the box

For the next agent, working **on the Linux host** (single-node k3s, Tailscale-only
admin). Everything below was verified on a developer machine, not on the box.
**Nothing has been deployed to the server yet.**

Last updated 2026-09-27, after adding live updates.

---

## Read these first, in this order

1. **That box's own `CLAUDE.md`** — it overrides anything here. Especially: the
   preflight, what needs asking before doing, and what is never done.
2. **`DEPLOY.md`** (this repo) — the actual steps.
3. **`plan.md`** — why the choices were made, and what is still open.

---

## What this is

A wedding seating planner. One page (`index.html`, Azerbaijani UI, with its
icon `favicon.ico` beside it) plus a small Express API in `server/`. Those two
files are all the server serves statically; the repo is not exposed. The whole dataset is a **single JSONB document** —
deliberately, because there is one editor and `moveGuest`/`switchGuests` each
touch two masas at once, which as a single-document write needs no cross-row
transaction.

Every open page is **live**: when anyone saves, every other open page shows the
change within about a second, with no refresh. See "Live updates" below.

- Repo: <https://github.com/TheRehim/TablePlanner> (**public**)
- Image: `ghcr.io/therehim/tableplanner` — **public**, no pull secret needed
- CI: pushing to `main` rebuilds and publishes.
- **Do not trust the digest committed in `deployment.yaml`.** Image labels
  embed the commit SHA, so every push publishes a new digest and the committed
  value is stale immediately. Resolve the real one first:

  ```bash
  sh server/scripts/current-digest.sh          # or: ... v1.0.0 for a tag
  ```

  The image you want contains `src/live.js`. Anything older has no live
  updates — pages would only see other people's changes after a refresh.

---

## State

**Works, verified locally (2026-09-27, real image + Postgres 16 via compose):**

- Image builds, runs non-root, no secrets baked in.
- `docker compose up --build` → Postgres + app, migrations applied, data **and
  its version number** survive restarting **both** containers.
- **32 smoke checks pass** (`cd server && BASE=... PASSWORD=... npm run smoke`),
  including the 4 live-update checks and the favicon.
- Azerbaijani text round-trips through API and Postgres (`npm run utf8check`).
- Auth: one shared password (scrypt), signed httpOnly cookie.
- Visibility: `private` (default) or `public`, stored in the document,
  **enforced server-side** — private returns 401 from `GET /api/state` for
  anonymous callers, so the guest names are refused, not merely hidden.
- Live updates, driven in a real browser: a table added through the UI in one
  tab appeared in a second tab with no reload; closing the list put an
  anonymous viewer behind the lock screen live and dropped the data from the
  page; opening it again unlocked them; a server restart showed "Canlı deyil"
  and the page reconnected and caught up on its own.
- SIGTERM with live streams open exits cleanly (code 0), not via the 10s kill.
- Idles at **~20 MiB**; the 192Mi limit is generous.

**Not done:**

- Never deployed to the box. No namespace, no database, no secret exists there.
- Real password not chosen (`npm run hash-password`).
- No Ingress, no TLS, no domain.
- Live updates never tested through Traefik (only direct and via Docker).
- Excel import is still wrong on real files — see "Known broken" below.

---

## Do this

Follow `DEPLOY.md`. Condensed:

1. **Preflight** (`free -m`, `df -h /`, `kubectl top nodes`,
   `kubectl get pods -A | grep -v Running`). Stop if RAM < 1500 MB or disk > 75%.
2. **Ask before touching `data/`.** Then create the database, user, grants.
   Note the Postgres 15+ `GRANT ALL ON SCHEMA public` — without it the
   migration fails with a permission error.
3. **Secrets** → Sealed Secret named `tableplanner-secrets`, keys
   `DATABASE_URL`, `SESSION_SECRET`, `EDITOR_PASSWORD_HASH`.
4. Resolve the digest (above), put it in `deployment.yaml` (app **and**
   initContainer), `kubectl apply --dry-run=server -f server/deploy/` first,
   then apply into **`lab/`**. Promote to `apps/` only once it has proven itself.
5. Reach it with `kubectl -n lab port-forward svc/tableplanner 3000:80`.
   **No Ingress yet** — see "Before going public".
6. Verify with the smoke suite, then by hand from a logged-out browser, then
   the live check: two windows, change something in one, watch the other.

---

## Live updates

How it works: each open page holds one `GET /api/events` stream
(Server-Sent Events). After a successful `PUT /api/state` the server pushes
`{version, visibility}` — **never the data** — and each page re-reads
`/api/state` itself. So the private/public check still lives in exactly one
place; the stream is open to anonymous callers on purpose (a locked page has
to learn that the list was opened), and all it tells them is a version number
and a visibility that `/api/me` already hands out.

Client rules, in `index.html` (search for "Live updates"):

- A viewer applies a remote change immediately.
- An editor with a modal open (every form and inline input lives in one)
  waits; the badge says "Yeni dəyişiklik var" and it applies on close.
- A local save in flight, or a failed one, is never overwritten by a remote
  change — it lands, or it hits the existing 409 conflict prompt.
- The page's own save is not re-fetched (its version already matches).
- On reconnect the server sends the current version, so a page that slept or
  lost the network catches up. A version *lower* than the page's means the
  database was reset or restored; the page takes the server's copy.

---

## Things that will bite you

**Live updates assume one replica.** The broadcast is in-process
(`server/src/live.js`). That is correct with `replicas: 1` + `Recreate`, as
deployed. Scale out and pages connected to one pod miss writes made through
another — switch `live.js` to Postgres `LISTEN/NOTIFY` first. Likewise, a
change made straight in the database (psql, a restore) is not announced; pages
pick it up on their next reconnect or the next write.

**Nothing in front may buffer `/api/events`.** Traefik streams by default, and
the response sets `x-accel-buffering: no` and `cache-control: no-transform`.
If changes only appear after a refresh once an Ingress exists, a middleware
(compression, buffering) is holding the stream. A 25s heartbeat keeps idle
timeouts from cutting it.

**`TRUST_PROXY_HOPS` also governs the live-stream cap.** Streams are capped at
500 total and 20 per client IP (`LIVE_MAX_CLIENTS`, `LIVE_MAX_PER_IP`). If the
hop count is wrong, every visitor looks like Traefik's IP and the whole site
shares 20 streams — pages past that show "Canlı deyil". It is the same setting
the login rate limiter already depends on. Via `port-forward` everyone is
127.0.0.1, which is fine for a lab.

**The Service type is the firewall decision.** NodePort and LoadBalancer bypass
the host firewall on this box — traffic is DNAT'd in PREROUTING and traverses
FORWARD, not INPUT, so `ufw`/`nftables` INPUT rules do not block it. Leave it
`ClusterIP`.

**Migrations do not run from the image's CMD.** Compose runs them in its
`command:`; the k8s path uses an `initContainer`. If you replace the
Deployment, keep that initContainer or the app starts against an empty
database. Readiness catches this (`503 — schema missing`) rather than
reporting Ready while every read 500s, but the initContainer is what prevents
it happening.

**`readOnlyRootFilesystem` needs a writable `/tmp`.** There is an `emptyDir`
mounted there. Remove it and the pod builds fine, then crashes at runtime.

**Liveness must not touch the database.** `/healthz` deliberately does not;
`/readyz` does. Wiring liveness to the DB means a DB blip restarts the pod in a
loop, which is worse than the blip.

**The password hash is `:`-separated, not `$`.** That is deliberate — `$` is
variable interpolation to Docker Compose, the shell and `envsubst`, all of
which this value passes through. Do not "normalise" it back to `$`.

**Visibility fails closed, on purpose.** Default private; a write that omits
`settings` inherits the current value rather than reverting to public; any
value that is not exactly `"public"` is stored as private. Do not add a
convenience path that skips this.

**`commit()` is the single write seam in the front end.** Every mutation goes
`<mutate weddingData>; commit(action)`. `renderApp()` is a read-only re-render
and must never be used as a write hook, or that change silently never persists
— and a live update calls `renderApp()` too.

---

## Unverified — check before trusting

**Does the backup job run `pg_dumpall`, or a named list of databases?**
This is the one that matters. The entire argument for Postgres over a JSON file
was "the database is already backed up". If it is a named list, a new
`tableplanner` database is backed up by **nobody** until you add it. Check the
job before putting real guest data in.

**The box is XE4; its `CLAUDE.md` documents XE7** (12 vCore / 16 GB). Every
memory number assumes that. Run `free -m` and `nproc`, and correct the file —
it is what future sessions size against.

---

## Known broken

**Excel import puts values in the wrong fields on real files.** Two rounds of
fixes (caption rows; then per-masa column mapping derived from the caption
strip, with inference as a fallback) both verified against synthetic layouts,
and neither fixed the user's actual file. The cause is something the synthetic
tests and the empty `Masa_numune` template do not contain.

Do not guess at a third fix. What will settle it:

- a **filled** copy of the workbook, or 3–4 real rows pasted as text; or
- the **"Sütunlar:"** line the import preview prints — it names the chosen
  offsets and whether they came from the caption row or a guess.

Workaround: an explicit `Ad | Haradan | Say` header row in the sheet makes the
mapping exact instead of inferred.

---

## Before going public (each needs the user's approval)

1. Move to `apps/`.
2. Domain + DNS record.
3. `COOKIE_SECURE=true` — otherwise the session cookie is never stored over
   HTTPS and login silently fails.
4. Ingress + cert-manager (`server/deploy/ingress.yaml.example`). Then repeat
   the live check over the real domain — see "Nothing in front may buffer".
5. **Decide visibility deliberately.** It defaults to private. The guest list
   holds real names. `noindex` is set, but that only asks search engines nicely.
6. Restore test: dump → restore into a scratch database → confirm the data is
   real. Never assume a backup is good.

Also worth raising with the user: **GitHub Pages is enabled on the repo**, so
`index.html` is served at `therehim.github.io/TablePlanner`. It runs with no
API and therefore no data (and no live stream), so nothing leaks today — but it
is a second copy of the app with no auth in front of it.

---

## Useful commands

```bash
# local stack
cd server && docker compose up --build

# local, no Postgres at all (state dies with the process)
DATABASE_URL=memory: SESSION_SECRET=... EDITOR_PASSWORD_HASH=... node server/src/server.js

# tests (against anything)
BASE=http://localhost:3000 PASSWORD='...' npm run smoke
BASE=http://localhost:3000 PASSWORD='...' npm run utf8check

# watch the live stream by hand
curl -N http://localhost:3000/api/events

# on the box
kubectl -n lab rollout status deploy/tableplanner
kubectl -n lab logs deploy/tableplanner -c migrate     # initContainer
kubectl -n lab logs deploy/tableplanner
kubectl top pod -n lab
kubectl -n lab rollout undo deploy/tableplanner
```

Rollback does not touch the data: it lives in Postgres, and every write also
appends to `wedding_revision`, so a bad import is recoverable from there rather
than from a backup. Rolling back to an image without `live.js` just turns live
updates off: the old image serves the old page, which works on refresh as
before. Tabs still open from the new page show "Canlı deyil" until reloaded.
