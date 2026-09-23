# TablePlanner server

API and host for the planner. Serves the repo-root `index.html` — there is no
second copy of the app to keep in sync.

## Run it

### 1. No database at all (fastest look)

```bash
cd server
npm install
npm run hash-password          # prints EDITOR_PASSWORD_HASH and SESSION_SECRET
cp .env.example .env           # paste both values in
DATABASE_URL=memory: npm start
```

Open <http://localhost:3000>. **Memory mode keeps nothing** — everything is lost
when the process stops. It is for a quick look, never for real planning.

### 2. Docker Compose (self-contained, with Postgres)

```bash
cd server
npm run hash-password          # then put both values in server/.env
docker compose up --build
```

Postgres comes up, migrations run, the app starts on
<http://localhost:3000>. Data lives in the `tableplanner-db` volume.

### 3. Against an existing Postgres

```bash
cd server
export DATABASE_URL='postgres://user:pass@host:5432/tableplanner'
npm run migrate
npm start
```

## The password

`npm run hash-password` prompts with echo off, then prints a scrypt hash. The
plaintext is never written to disk, never printed, and never sent anywhere —
only the hash is stored, in `EDITOR_PASSWORD_HASH`.

The hash is `scrypt:N:r:p:salt:key`, separated with `:` rather than `$` on
purpose: `$` means variable interpolation to Docker Compose, the shell and
`envsubst`, all of which this value has to pass through.

## Access model

Two levels, no user table:

| | read, filter, print | edit |
|---|---|---|
| anonymous | yes | no |
| holds the password | yes | yes |

**Read-only is enforced by the server.** The page hides its editing controls
for anonymous visitors, but that is presentation only — anyone can re-enable
them from the console. `PUT /api/state` returning 401 is the actual boundary,
and there is a test for exactly that.

## API

| Route | Auth | Notes |
|---|---|---|
| `GET /` | public | the app |
| `GET /api/state` | public | `{data, version, canEdit}` |
| `PUT /api/state` | editor | `{data, version, action}`; **409** if stale |
| `POST /api/login` | public | rate limited, 10/min per IP |
| `POST /api/logout` | — | |
| `GET /api/me` | public | `{canEdit}` |
| `GET /api/revisions` | editor | recent history |
| `GET /healthz` | public | liveness — **never touches the DB** |
| `GET /readyz` | public | readiness — checks Postgres |

Liveness deliberately ignores the database: a DB blip should not get the pod
killed and restarted in a loop.

### Concurrency

Every write sends the `version` it last saw. If someone else wrote first the
server answers `409` with the current version and changes nothing; the page
then offers to load the server copy rather than silently overwriting. The state
row and its revision are written in one transaction, so history can never
disagree with the current document.

## Front end behaviour

`index.html` works in two modes and picks automatically at boot:

- **Served by this API** — the server is the source of truth. Edits save
  automatically (debounced 400 ms, one request in flight at a time). The badge
  in the bottom bar reads `Saxlanıldı` / `Saxlanılır…` / `Yadda saxlanmadı`.
- **Opened straight from disk** — no API answers, so it stays entirely in
  memory exactly as before, badged `Yerli rejim` with a tooltip saying changes
  are lost on refresh.

Every mutation still goes through one function, `commit(action)`. That remained
the single write seam; wiring persistence touched no call site.

## Tests

```bash
BASE=http://localhost:3000 PASSWORD='...' npm run smoke
```

Covers auth, cookie tampering, the anonymous-write boundary, optimistic
concurrency (including a deliberate stale write), payload validation and
revision history. Add `EXPECT_DB=false` to skip the database-backed checks.

## Deploying to the k3s box

Manifests are in `deploy/`. Read `../plan.md` first — it carries the rules that
apply to that host. In short:

- `ClusterIP` only. NodePort and LoadBalancer **bypass the host firewall**
  there, so the Service type is the firewall decision.
- `resources.limits.memory` is mandatory; one unbounded pod takes the node down.
- Pin the image by digest. Never `:latest`.
- Secrets go in via Sealed Secrets — see `deploy/secret.example.yaml` for a
  pipeline that keeps the plaintext out of files and shell history.
- `readOnlyRootFilesystem` is on, with an `emptyDir` mounted at `/tmp`, because
  Node still wants somewhere to write.
