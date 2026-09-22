# TablePlanner — build and deploy plan

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

## Phase 1 — repo structure

```
TablePlanner/
├─ public/
│  └─ index.html              ← the app (moved from repo root)
├─ src/
│  ├─ server.js               ← express: static + api
│  ├─ db.js                   ← pg pool, single jsonb row
│  └─ auth.js                 ← one shared password → signed cookie
├─ migrations/
│  └─ 001_init.sql
├─ deploy/
│  ├─ deployment.yaml
│  ├─ service.yaml
│  ├─ ingress.yaml            ← phase 7 only
│  └─ sealedsecret.yaml
├─ Dockerfile
├─ compose.yaml               ← local dev only, never deployed
├─ package.json
├─ plan.md
└─ README.md
```

- [ ] `git mv index.html public/index.html`
- [ ] `package.json` — `express`, `pg`, `cookie-parser`; Node 20
- [ ] `.env.example` with **no real values** — `DATABASE_URL`, `SESSION_SECRET`,
      `EDITOR_PASSWORD_HASH`, `PORT`
- [ ] `compose.yaml` — app + throwaway Postgres, for local development only

---

## Phase 2 — server (~150 lines)

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

## Phase 3 — app wiring

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

## Phase 5 — image

- [ ] Multi-stage `Dockerfile`, `node:20-alpine`, **non-root** user, `NODE_ENV=production`
- [ ] Build and push to GHCR, **pinned by digest**. Never `:latest` — box rule
- [ ] Run it locally against the compose Postgres before it goes near the server

---

## Phase 6 — deploy to `lab/`

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

## Open questions

- Single editor, or several at once? The plan assumes one. Several would mean the `409`
  path gets exercised constantly and is worth designing around rather than bolting on.
- Guest types now seed as a single type, `Dost`. Everything else is expected to arrive
  from the sheet's `Haradan` column or be added in the Tiplər manager.
