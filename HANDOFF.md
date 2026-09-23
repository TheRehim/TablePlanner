# Handoff — deploying TablePlanner on the box

For the next agent, working **on the Linux host** (single-node k3s, Tailscale-only
admin). Everything below was verified on a developer machine, not on the box.
Nothing has been deployed to the server yet.

---

## Read these first, in this order

1. **That box's own `CLAUDE.md`** — it overrides anything here. Especially: the
   preflight, what needs asking before doing, and what is never done.
2. **`DEPLOY.md`** (this repo) — the actual steps.
3. **`plan.md`** — why the choices were made, and what is still open.

---

## What this is

A wedding seating planner. One page (`index.html`, Azerbaijani UI) plus a small
Express API in `server/`. The whole dataset is a **single JSONB document** —
deliberately, because there is one editor and `moveGuest`/`switchGuests` each
touch two masas at once, which as a single-document write needs no cross-row
transaction.

- Repo: <https://github.com/TheRehim/TablePlanner> (**public**)
- Image: `ghcr.io/therehim/tableplanner` — **public**, no pull secret needed
- Pinned digest:
  `sha256:ee069d3281e3266e27c0d7c7e18bdd5dfe4f083b1113ac603f69f1b70a06c587`
- CI: pushing to `main` rebuilds and publishes; the run summary prints the new
  digest to pin in `server/deploy/deployment.yaml`.

---

## State

**Works, verified locally:**

- Image builds, runs non-root, no secrets baked in.
- `docker compose up --build` → Postgres + app, migrations applied, data
  survives restarting **both** containers.
- 25 smoke checks pass (`cd server && BASE=... PASSWORD=... npm run smoke`).
- Azerbaijani text round-trips through API and Postgres (`npm run utf8check`).
- Auth: one shared password (scrypt), signed httpOnly cookie.
- Visibility: `private` (default) or `public`, stored in the document,
  **enforced server-side** — private returns 401 from `GET /api/state` for
  anonymous callers, so the guest names are refused, not merely hidden.
- Idles at **~18 MiB**; the 192Mi limit is generous.

**Not done:**

- Never deployed to the box. No namespace, no database, no secret exists there.
- Real password not chosen (`npm run hash-password`).
- No Ingress, no TLS, no domain.
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
4. `kubectl apply --dry-run=server -f server/deploy/` first, then apply into
   **`lab/`**. Promote to `apps/` only once it has proven itself.
5. Reach it with `kubectl -n lab port-forward svc/tableplanner 3000:80`.
   **No Ingress yet** — see "Before going public".
6. Verify with the smoke suite, then by hand from a logged-out browser.

---

## Things that will bite you

**The Service type is the firewall decision.** NodePort and LoadBalancer bypass
the host firewall on this box — traffic is DNAT'd in PREROUTING and traverses
FORWARD, not INPUT, so `ufw`/`nftables` INPUT rules do not block it. Leave it
`ClusterIP`.

**Migrations do not run from the image's CMD.** Compose runs them in its
`command:`; the k8s path uses an `initContainer`. If you replace the
Deployment, keep that initContainer or the app starts against an empty
database. Readiness now catches this (`503 — schema missing`) rather than
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
and must never be used as a write hook, or that change silently never persists.

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
4. Ingress + cert-manager (`server/deploy/ingress.yaml.example`).
5. **Decide visibility deliberately.** It defaults to private. The guest list
   holds real names. `noindex` is set, but that only asks search engines nicely.
6. Restore test: dump → restore into a scratch database → confirm the data is
   real. Never assume a backup is good.

Also worth raising with the user: **GitHub Pages is enabled on the repo**, so
`index.html` is served at `therehim.github.io/TablePlanner`. It runs with no
API and therefore no data, so nothing leaks today — but it is a second copy of
the app with no auth in front of it.

---

## Useful commands

```bash
# local stack
cd server && docker compose up --build

# tests (against anything)
BASE=http://localhost:3000 PASSWORD='...' npm run smoke
BASE=http://localhost:3000 PASSWORD='...' npm run utf8check

# on the box
kubectl -n lab rollout status deploy/tableplanner
kubectl -n lab logs deploy/tableplanner -c migrate     # initContainer
kubectl -n lab logs deploy/tableplanner
kubectl top pod -n lab
kubectl -n lab rollout undo deploy/tableplanner
```

Rollback does not touch the data: it lives in Postgres, and every write also
appends to `wedding_revision`, so a bad import is recoverable from there rather
than from a backup.
