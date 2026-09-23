# TablePlanner — build and deploy plan

> **Status:** Phases 1, 2, 3, 5 and 6 are built and live in `server/`.
> See `server/README.md` to run it. Remaining: Phase 0 (confirm the box),
> Phase 4 (the real database on the server) and Phase 7 (go public).
>
> Departures from the plan as written, both deliberate:
> - Code lives in `server/` rather than restructuring the repo root. The server
>   serves the root `index.html` directly, so there is still only one copy of
>   the app.
> - Node **22**, not 20 — Node 20 reached end of life in April 2026.

Target host: single-node **k3s** box (sunucum.net.tr XE4, Istanbul), admin over Tailscale
only. Operating rules for that box live in its own `CLAUDE.md` — this plan follows them.

There is one node. No failover. Every destructive action is production-affecting.

---

## ⚠ Verify before trusting this plan

**The choice of Postgres over a JSON file rests on "the database is already backed up".
That has not been confirmed.** If the backup job runs `pg_dump` against a named list of
databases rather than `pg_dumpall`, a new `tableplanner` database is backed up by
nobody, and the main argument for Postgres disappears.

Check the job first. If it is a named list, adding the new database to it is item zero.

---

## Phase 0 — confirm first

These change the numbers in the rest of the plan.

- [ ] **Real XE4 specs** — `free -m`, `nproc`. The box's `CLAUDE.md` documents XE7
      (12 vCore / 16 GB). Every memory limit below assumes headroom that may not exist.
      Correct the file too — it is what future sessions size against.
- [ ] **Preflight** (mandated by the box rules, run before any deploy):
      ```
      free -m                      # need > 1500 MB available
      df -h /                      # need < 75% used
      kubectl top nodes
      kubectl get pods -A | grep -v Running
      ```
      Stop and report if RAM or disk is outside those bounds.
- [ ] **Postgres in `data/`** — service name, port, version. Gives the connection host,
      normally `<svc>.data.svc.cluster.local:5432`.
- [ ] **Backup job scope** — `pg_dumpall`, or a named list? (see warning above)
- [ ] **GHCR pull** — does an imagePullSecret already exist on the cluster, or does one
      need creating for a private image?

---

## Phase 1 — repo structure ✅ done

```
TablePlanner/
├─ index.html                 ← the app, left at the root and served from there
├─ plan.md
├─ README.md
└─ server/
   ├─ src/{server,db,auth}.js
   ├─ migrations/001_init.sql
   ├─ scripts/{migrate,hash-password,smoke}.mjs
   ├─ deploy/{deployment,service}.yaml + ingress/secret examples
   ├─ Dockerfile               ← build context is the REPO ROOT
   ├─ compose.yaml
   ├─ .env.example
   └─ README.md
```

- [x] app stays at the repo root; the server serves it (no duplicate copy)
- [x] `package.json` — `express`, `pg`, `cookie-parser`; **Node 22**
- [x] `.env.example` with no real values
- [x] `compose.yaml` — app + Postgres, one command

---

## Phase 2 — server ✅ done

- [ ] `src/db.js` — `pg` pool; read and write the single state row
- [ ] `src/auth.js` — one shared password stored **hashed** (scrypt or bcrypt), issuing a
      signed `httpOnly`, `SameSite=Lax` cookie. No user table, no roles: there are exactly
      two access levels, editor and anonymous.
- [ ] `src/server.js`

  | Route | Auth | Notes |
  |---|---|---|
  | `GET /api/state` | public | returns `{data, version, canEdit}` |
  | `PUT /api/state` | **required** | body `{data, version}`; `409` if stale |
  | `POST /api/login` | public | rate-limited |
  | `POST /api/logout` | — | |
  | `GET /healthz` | public | no DB touch — liveness |
  | `GET /readyz` | public | `SELECT 1` — readiness |

  Plus static-serving `public/`.

- [ ] `PUT` writes the state row **and** a `wedding_revision` row in one transaction
- [ ] JSON body limit ~2 MB

**Read-only is enforced here, not in the browser.** The app's `?view=1` flag only hides
controls; anyone can flip it from the console. The server rejecting the `PUT` is the
actual boundary.

---

## Phase 3 — app wiring ✅ done

This is the "make the app actually work" half. The front end currently holds everything
in memory and loses it on refresh.

- [ ] On boot: `GET /api/state` → hydrate `weddingData`, reseed `idCounter`, `renderApp()`
- [ ] `commit()` → `PUT /api/state` with the current `version`; store the returned one
- [ ] On `409`: tell the user and re-fetch. Never silently overwrite someone's change
- [ ] On network failure: toast, and keep the in-memory state rather than blanking the UI
- [ ] `readOnly = !canEdit` from the server response — delete the `?view=1` check
- [ ] Small login modal for the editor
- [ ] Add `<meta name="robots" content="noindex">` before the page is public

### Why this is a small change

Every mutation already funnels through one function:

```js
<mutate weddingData>;  commit('<what changed>');
```

`commit()` is the only place the app reacts to a write. Wire persistence there and no
call site changes. `renderApp()` is a read-only re-render and must never be used as a
write hook, or that change silently skips persistence.

The 13 write actions: `addTable`, `editTable`, `deleteTable`, `addGuest`, `editGuest`,
`deleteGuest`, `moveGuest`, `switchGuests`, `addType`, `renameType`, `deleteType`,
`importData`, `importTable`.

`moveGuest` and `switchGuests` each touch **two** masas. Under per-entity endpoints they
would need a transaction; as a single-document write that problem does not arise.

---

## Phase 4 — database

**Anything in `data/` needs explicit approval** — it is shared by every app on the box.
These operations are additive (`CREATE`), with no DDL against anything that already
exists.

- [ ] `CREATE DATABASE tableplanner;` plus a dedicated user, granted on that DB only
- [ ] `migrations/001_init.sql`:

```sql
CREATE TABLE wedding_state (
  id         int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  data       jsonb       NOT NULL,
  version    int         NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE wedding_revision (
  id         bigserial PRIMARY KEY,
  data       jsonb       NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
```

- [ ] Seed: `INSERT INTO wedding_state (id, data) VALUES (1, '{"guestTypes":[],"tables":[]}');`
- [ ] Credentials via **Sealed Secret**. Never plaintext in a manifest, never echoed to a
      terminal or log
- [ ] Add the database to the backup job if it uses a named list

`wedding_revision` is append-only. It is both the undo history and the safety net for a
bad import — which matters more now that Excel import exists.

---

## Phase 5 — image ✅ written, build not yet verified

- [x] Multi-stage `Dockerfile`, `node:22-alpine`, non-root, `NODE_ENV=production`
- [ ] **The image has never actually been built** — Docker Desktop was not
      running. `docker compose up --build` is the first thing to try.
- [ ] Push to GHCR, **pinned by digest**. Never `:latest` — box rule

---

## Phase 6 — deploy to `lab/` ✅ manifests written, not yet applied

`lab/` can be deployed, restarted and deleted freely. Prove it there, then promote.

- [ ] `deployment.yaml`
  - 1 replica
  - `resources.requests.memory: 96Mi`
  - **`resources.limits.memory: 192Mi` — mandatory.** On this box one unbounded pod takes
    down everything else. Node idles at 60–80 MB, so ~200 MB baseline, under the 500 MB
    ask-first threshold
  - probes: `/healthz` liveness, `/readyz` readiness
  - env from the Sealed Secret
- [ ] `service.yaml` — **ClusterIP**

  > Not NodePort, not LoadBalancer. On this box those bypass the host firewall: service
  > traffic is DNAT'd in PREROUTING and traverses FORWARD, not INPUT, so `ufw`/`nftables`
  > INPUT rules do not block it. **The Service type is the firewall decision.**

- [ ] `kubectl apply --dry-run=server -f deploy/` before applying for real
- [ ] Apply, then reach it with `kubectl port-forward` over Tailscale. No Ingress yet —
      and no public exposure while the app still has no auth
- [ ] Check real usage against the limit: `kubectl top pod -n lab`

---

## Phase 7 — promote and publish

Every item here needs explicit approval.

- [ ] Move to the `apps/` namespace
- [ ] Domain and DNS record
- [ ] Ingress + cert-manager certificate
- [ ] Confirm anonymous access is read-only **from a logged-out browser**, not merely from
      hidden buttons
- [ ] Restore test: dump → restore into a scratch database → confirm the data is real.
      Never assume a backup is good

---

## Not blocking

- [ ] **Undo stack** — roughly 30 lines now that every write goes through `commit()`:
      snapshot before mutating, Ctrl+Z pops. Worth more on the night than anything in
      Phase 7. There is currently no way back from a misclick, and deleting a masa takes
      its guests with it.
- [ ] Drag and drop between masas
- [ ] CSV export alongside the JSON export
- [ ] "Unassigned" pool — real planning goes guest list first, seating second

---

## Known defect — Excel import still wrong on real files

**Status: open.** Importing a real workbook still puts values in the wrong fields
(guest names appearing as the type). Two rounds of fixes have not closed it:

1. Caption rows (`FullName | kind | count`) were being imported as a guest — fixed.
2. Columns were read from fixed offsets `+0/+1/+2` relative to the masa title, which
   breaks on merged titles, spacer columns and reordered columns. Each masa now derives
   its own mapping from the caption strip, falling back to inference — fixed, and
   verified across nine synthetic layouts.

Neither round fixed the real file, so **the remaining cause is something not present in
the synthetic tests or in the empty `Masa_numune` template.** Every test so far has been
built from an assumed structure rather than from real data.

### What will actually settle it

- [ ] A **filled** copy of the workbook, or even 3–4 real rows pasted as text. Without
      it, fixes are guesses against an imagined layout.
- [ ] Failing that: open the import preview and read the **"Sütunlar:"** line. It states
      which offsets were chosen and whether they came from the caption row or a guess.
      That single line identifies the misread immediately.

### Workaround until then

Adding an explicit header row to the sheet — `Ad | Haradan | Say` — makes the mapping
exact rather than inferred, in both the board and flat layouts.

---

## Remaining work

Per the latest pass, this is essentially all that is left.

### 1. Auth — mostly built, not finished

Done: one shared password (scrypt, `:`-separated), signed `httpOnly` cookie,
`requireEditor` on every write, login rate limited, anonymous `PUT` rejected
with 401. Verified from a browser, not just by reading.

Still to do:

- [ ] Choose the real password — `cd server && npm run hash-password`. The
      plaintext never leaves the machine that runs it; only the hash is stored.
- [ ] `COOKIE_SECURE=true` once it is behind TLS, or the cookie is never stored.
- [ ] Session length: currently 14 days (`SESSION_HOURS`). Confirm or change.
- [ ] Put the secrets in a Sealed Secret for the cluster, never plaintext.

### 2. Public / auth-only switch

A single setting deciding whether anonymous visitors may **read** at all:

| mode | anonymous | editor |
|---|---|---|
| `public` (today's behaviour) | read, filter, print | everything |
| `private` | nothing — login page only | everything |

- [ ] Store it in the state document (`settings.visibility`) so it survives
      restarts and is editable in the app, not baked into an env var.
- [ ] **Enforce it server-side.** In `private`, `GET /api/state` must return
      401 for anonymous callers and `GET /` must serve a login page instead of
      the planner. Hiding the UI is not enough — the data is what has to be
      refused, exactly as with writes today.
- [ ] Toggle in the UI, editor only.
- [ ] Default to `private`. The guest list holds real names, so the safe
      default is closed, opened deliberately.
- [ ] Only then is the Ingress (Phase 7) safe to apply.

### 3. Standing UI rule

- [x] **No native browser dialogs.** No `alert()`, `confirm()` or `prompt()` —
      everything goes through a Bootstrap modal (`askConfirm`) or inline
      confirmation in the row. Currently zero native dialogs remain; keep it
      that way for anything added later.

---

## Open questions

- Single editor, or several at once? The plan assumes one. Several would mean the `409`
  path gets exercised constantly and is worth designing around rather than bolting on.
- Guest types now seed as a single type, `Dost`. Everything else is expected to arrive
  from the sheet's `Haradan` column or be added in the Tiplər manager.
