# Handoff — deploying TablePlanner on the box

For the next agent, working **on the Linux host** (single-node k3s, Tailscale-only
admin). Everything below was verified on a developer machine, not on the box.
As of writing, **nothing had been deployed to the server** — check
`kubectl get deploy -A | grep tableplanner` before assuming either way; the
steps differ (see "Do this").

Last updated 2026-09-27, for the dense-board / drag-and-drop release.

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
files are all the server serves statically; the repo is not exposed. The whole
dataset is a **single JSONB document** — deliberately, because there is one
editor and moving or switching a guest touches two masas at once, which as a
single-document write needs no cross-row transaction.

- Repo: <https://github.com/TheRehim/TablePlanner> (**public**)
- Image: `ghcr.io/therehim/tableplanner` — **public**, no pull secret needed
- CI: pushing to `main` rebuilds and publishes.
- **Do not trust the digest committed in `deployment.yaml`.** Image labels
  embed the commit SHA, so every push publishes a new digest and the committed
  value is stale immediately. Resolve the real one, and check it is the build
  you expect:

  ```bash
  sh server/scripts/current-digest.sh          # or: ... v1.0.0 for a tag
  # the commit it was built from:
  docker buildx imagetools inspect <digest> --format '{{json .Image.Config.Labels}}' | grep revision
  ```

---

## What is in this version

Everything since the first handoff, newest first. Only the last item is new
for this release; the rest shipped in images already published.

| | What | Where |
|---|---|---|
| **new** | **Dense board.** 12px text, 13px masa names / counts / filter bar. Card header is one line, `Masa 1 - 18/18` (state colour on the count; the "Tam doludur / N boş yer" text is its hover title). No column-header row. Plain small badges, type badge max 75px. Page title, hints and "Yeni Masa" moved into the bottom bar. | `index.html` |
| **new** | **Card sizing from the data.** Columns = longest name (cap 170px, then wraps) + widest type badge + widest count + the three buttons. As many cards per row as fit at that width, stretched to fill the row exactly, 4px apart. Each grid row is as tall as its tallest masa. | `sizeTableColumns()` |
| **new** | **Drag and drop** (jQuery UI 1.14.1 + Touch Punch). Drop a guest on another masa → **move** (that masa green). Drop a guest on a guest of another masa → **switch** (both masas and both rows orange). Editors only. | `initDragDrop()` |
| **new** | **Smoke / utf8check refuse to overwrite a board that has masas** unless `SMOKE_OVERWRITE=yes`. | `server/scripts/` |
| earlier | Favicon at `/favicon.ico`. | `server.js` |
| earlier | **Live updates** over Server-Sent Events — no refresh needed. | `src/live.js` |

No server behaviour, schema, migration, env var or manifest changed in this
release. It is a front-end release plus a safety guard in the test scripts.

---

## State

**Verified locally (2026-09-27, the real image + Postgres 16 via compose):**

- Image builds, runs non-root, no secrets baked in.
- Migrations applied; data **and its version number** survive restarting
  **both** containers.
- **32 smoke checks pass** on an empty board (`npm run smoke`), and
  `npm run utf8check` passes.
- The new guard: on a board with masas, smoke skipped its writes, ran its 14
  read-only checks and left the data at the same version; utf8check refused
  (exit 2) and changed nothing; with `SMOKE_OVERWRITE=yes` both ran in full.
- In the browser against that stack: jQuery UI 1.14.1 and Touch Punch load,
  favicon loads, live stream connects, fonts 12/13px, a drag-and-drop move was
  saved to Postgres as one revision.
- Earlier in the same session, with a real mouse: move and switch both worked
  and saved; the Köçür / Dəyiş modal still works (it now calls the same two
  functions); row buttons still click rather than start a drag; a live update
  arriving mid-drag waits until the drop; viewers get no drag and no buttons.
- Layout checked on the user's own 34-masa / 497-guest list: rows fill edge to
  edge with 0 px spare at 1024, 1280, 1440 and 1920 px windows; nothing clipped.
- Auth: one shared password (scrypt), signed httpOnly cookie.
- Visibility `private` (default) / `public`, **enforced server-side** — private
  returns 401 from `GET /api/state` for anonymous callers.
- SIGTERM with live streams open exits cleanly (code 0). Idles at ~20 MiB.

**Not done / not verified:**

- Never deployed to the box (as of writing).
- Real password not chosen (`npm run hash-password`).
- No Ingress, no TLS, no domain.
- Live updates never tested through Traefik.
- **Touch dragging never tried on a real phone or tablet** — Touch Punch maps
  touch to mouse events; it loads, but nobody has dragged with a finger.
- Excel import is still wrong on real files — see "Known broken".

---

## Do this

### A. First deploy (nothing on the box yet)

Follow `DEPLOY.md`. Condensed:

1. **Preflight** (`free -m`, `df -h /`, `kubectl top nodes`,
   `kubectl get pods -A | grep -v Running`). Stop if RAM < 1500 MB or disk > 75%.
2. **Ask before touching `data/`.** Then create the database, user, grants.
   Note the Postgres 15+ `GRANT ALL ON SCHEMA public` — without it the
   migration fails with a permission error.
3. **Secrets** → Sealed Secret named `tableplanner-secrets`, keys
   `DATABASE_URL`, `SESSION_SECRET`, `EDITOR_PASSWORD_HASH`.
4. Resolve the digest (above), put it in `deployment.yaml` — **both** the
   `migrate` initContainer and the `app` container —
   `kubectl apply --dry-run=server -f server/deploy/` first, then apply into
   **`lab/`**. Promote to `apps/` only once it has proven itself.
5. Reach it with `kubectl -n lab port-forward svc/tableplanner 3000:80`.
6. Verify: the board is empty at this point, so the full smoke suite is safe
   (`BASE=http://localhost:3000 PASSWORD=... npm run smoke`, 32 checks). Then by
   hand from a logged-out browser, then the live and drag checks in `DEPLOY.md`
   §5. Run smoke **before** the real guest list goes in, not after.

### B. Upgrade (an earlier version is already running)

Nothing but the image changes. Preflight first, as always.

```bash
IMG=$(sh server/scripts/current-digest.sh)          # confirm the revision label (above)
kubectl -n lab set image deploy/tableplanner migrate=$IMG app=$IMG
kubectl -n lab rollout status deploy/tableplanner
kubectl -n lab logs deploy/tableplanner -c migrate  # "done, 1 migration(s) applied." every time - it is idempotent
```

Or update both image lines in `deployment.yaml` and `kubectl apply`, so the
repo and the cluster agree. `Recreate` means a few seconds of downtime; open
pages show "Canlı deyil", then reconnect by themselves.

Then verify **without touching the data**:

- `npm run smoke` against it — with a real guest list it now **skips its write
  tests** and runs only read-only checks. Do not set `SMOKE_OVERWRITE=yes`.
- Do **not** run `npm run utf8check` here; it refuses anyway.
- By hand: log in, check the board looks dense and cards fill the width, drag a
  guest onto another masa and back again (two revisions, net no change).
- Take a JSON export from the ⋮ menu before and after if in doubt — it is the
  cheapest backup there is.

Rollback: `kubectl -n lab rollout undo deploy/tableplanner`. The data is not
touched; the old image serves the old page.

---

## Live updates

Each open page holds one `GET /api/events` stream (Server-Sent Events). After a
successful `PUT /api/state` the server pushes `{version, visibility}` — **never
the data** — and each page re-reads `/api/state` itself. So the private/public
check still lives in exactly one place; the stream is open to anonymous
callers on purpose (a locked page has to learn that the list was opened).

Client rules, in `index.html` (search for "Live updates"):

- A viewer applies a remote change immediately.
- An editor with a modal open, **or mid-drag**, waits; the badge says
  "Yeni dəyişiklik var" and it applies on close / on drop.
- A local save in flight, or a failed one, is never overwritten by a remote
  change — it lands, or it hits the existing 409 conflict prompt.
- On reconnect the server sends the current version, so a page that slept
  catches up. A *lower* version than the page's means the database was reset
  or restored; the page takes the server's copy.

---

## Things that will bite you

**The test scripts REPLACE the whole board.** `npm run smoke` leaves a single
"Smoke Masa"; `npm run utf8check` leaves one sample masa. Both now refuse when
the board already has masas, but `SMOKE_OVERWRITE=yes` removes that guard.
Never set it against the real database. If it happens anyway: the board from
just before is the previous row in `wedding_revision`
(`SELECT id, action, created_at FROM wedding_revision ORDER BY id DESC LIMIT 5`),
and `PUT` it back — or re-import the user's JSON export.

**The login rate limit is 10 attempts a minute per IP**, and every smoke /
utf8check run logs in. Several runs back to back get `429`. Wait a minute —
restarting the pod also clears it, but that is not a reason to restart it.

**The page loads its libraries from CDNs**: jQuery and jQuery UI from
`code.jquery.com`; Bootstrap, Select2, Touch Punch from `cdn.jsdelivr.net`;
Font Awesome from `cdnjs.cloudflare.com`. That was already true for jQuery,
Bootstrap and Select2 — the new ones use the same hosts. If jQuery UI fails
to load, drag-and-drop is simply off and the Köçür / Dəyiş button still moves
and switches. Browsers need those hosts; the pod does not.

**Live updates assume one replica.** The broadcast is in-process
(`server/src/live.js`) — correct with `replicas: 1` + `Recreate`, as deployed.
Scale out and pages on one pod miss writes made through another; switch
`live.js` to Postgres `LISTEN/NOTIFY` first. A change made straight in the
database (psql, a restore) is not announced either.

**Nothing in front may buffer `/api/events`.** Traefik streams by default, and
the response sets `x-accel-buffering: no` and `cache-control: no-transform`.
If changes only appear after a refresh once an Ingress exists, a middleware
(compression, buffering) is holding the stream.

**`TRUST_PROXY_HOPS` also governs the live-stream cap** (500 total, 20 per
client IP). Wrong hop count → every visitor looks like Traefik's IP → the
whole site shares 20 streams, and the login rate limit is shared too.

**The Service type is the firewall decision.** NodePort and LoadBalancer bypass
the host firewall on this box (DNAT in PREROUTING, then FORWARD, not INPUT).
Leave it `ClusterIP`.

**Migrations do not run from the image's CMD.** The k8s path uses the
`migrate` initContainer. Replace the Deployment without it and the app starts
against an empty database (readiness then reports `503 — schema missing`).
When changing the image, change it in **both** containers.

**`readOnlyRootFilesystem` needs a writable `/tmp`** (the `emptyDir`).

**Liveness must not touch the database.** `/healthz` does not; `/readyz` does.

**The password hash is `:`-separated, not `$`**, so Compose, the shell and
`envsubst` cannot mangle it. Do not "normalise" it.

**Visibility fails closed, on purpose.** Default private; a write without
`settings` keeps the current value; anything not exactly `"public"` is private.

**Front-end seams — keep them single:**

- `commit(action)` is the only write path. Every mutation is
  `<mutate weddingData>; commit(action)`. `renderApp()` only re-renders — live
  updates call it too — so it must never be used as a write hook.
- `moveGuestTo()` and `switchGuestsBetween()` are the only places a guest
  changes masa. The modal and drag-and-drop both call them; a switch is one
  commit touching both masas, never two.
- `sizeTableColumns()` measures from **all** guests, not the filtered ones, so
  filtering never makes cards jump. It runs on every render and again when the
  icon font finishes loading (button widths depend on it).

**The density is what the user asked for.** 12px / 13px, one-line headers, no
column headers, 4px gaps. Do not "restore" roomier defaults.

---

## Unverified — check before trusting

**Does the backup job run `pg_dumpall`, or a named list of databases?**
The whole argument for Postgres over a JSON file was "the database is already
backed up". If it is a named list, the `tableplanner` database is backed up by
**nobody** until it is added. Check before real guest data goes in.

**The box is XE4; its `CLAUDE.md` documents XE7** (12 vCore / 16 GB). Run
`free -m` and `nproc`, and correct the file.

---

## Known broken

**Excel import puts values in the wrong fields on real files.** Two rounds of
fixes verified against synthetic layouts did not fix the user's actual file.
Do not guess at a third fix. What will settle it: a **filled** copy of the
workbook, 3–4 real rows pasted as text, or the **"Sütunlar:"** line the import
preview prints. Workaround: an explicit `Ad | Haradan | Say` header row.

(JSON import — ⋮ → "Məlumatları idxal et (JSON)" — works; the user loaded a
34-masa / 497-guest list that way during testing.)

---

## Before going public (each needs the user's approval)

1. Move to `apps/`.
2. Domain + DNS record.
3. `COOKIE_SECURE=true` — otherwise the session cookie is never stored over
   HTTPS and login silently fails.
4. Ingress + cert-manager (`server/deploy/ingress.yaml.example`). Then repeat
   the live check over the real domain.
5. **Decide visibility deliberately.** It defaults to private. The guest list
   holds real names. `noindex` only asks search engines nicely.
6. Restore test: dump → restore into a scratch database → confirm the data is
   real. Never assume a backup is good.

Also worth raising: **GitHub Pages is enabled on the repo**, so `index.html` is
served at `therehim.github.io/TablePlanner` with no API and no data. Nothing
leaks today, but it is a second copy of the app with no auth in front of it.

---

## Useful commands

```bash
# local stack
cd server && docker compose up --build

# local, no Postgres at all (state dies with the process)
DATABASE_URL=memory: SESSION_SECRET=... EDITOR_PASSWORD_HASH=... node server/src/server.js

# tests — full suite only on an EMPTY board
BASE=http://localhost:3000 PASSWORD='...' npm run smoke
BASE=http://localhost:3000 PASSWORD='...' npm run utf8check
SMOKE_OVERWRITE=yes ...   # scratch databases only

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
appends to `wedding_revision`, so a bad import or a bad drag is recoverable
from there rather than from a backup.
