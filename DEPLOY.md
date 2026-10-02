# Deploying TablePlanner to the server

Target: the single-node **k3s** box, admin over Tailscale only. Its operating
rules live in that box's own `CLAUDE.md`; this follows them. `plan.md` has the
reasoning behind the choices — this is just the steps.

There is one node. No failover. Every destructive action is production-affecting.

---

## Before anything

```bash
free -m                      # need > 1500 MB available
df -h /                      # need < 75% used
kubectl top nodes
kubectl get pods -A | grep -v Running
```

**Stop if RAM is under 1500 MB or disk over 75%.** Deploying into a box that is
already tight evicts something that matters.

Measured locally, the app idles at **~18 MiB**, so the 192Mi limit below is
generous rather than tight.

Also still unconfirmed, and it decides whether Postgres is even the right
choice: **does the backup job run `pg_dumpall`, or a named list of databases?**
If it is a named list, a new `tableplanner` database is backed up by nobody
until you add it.

---

## 1. Get the image onto the box

Three ways. Pick one.

### a. GHCR via GitHub Actions — recommended

Pushing to `main` builds and publishes automatically
(`.github/workflows/docker.yml`). No registry password ever leaves a laptop.

**The package is already public** — confirmed by pulling it with no
credentials — so the box needs no pull secret:

```bash
docker pull ghcr.io/therehim/tableplanner@sha256:ffb9387d4d591259f1cc1d33b73406ba48decd2afb52700be76158c1660b9e07
```

If you ever make it private, create a pull secret and reference it:

```bash
kubectl -n lab create secret docker-registry ghcr \
  --docker-server=ghcr.io \
  --docker-username=TheRehim \
  --docker-password='<a PAT with read:packages>'
```

then add `imagePullSecrets: [{name: ghcr}]` to the pod spec.

**The digest in `deployment.yaml` will be out of date.** The image labels
embed the commit SHA, so every push to main publishes a new digest and any
value committed to the repo is stale the moment it lands. Resolve the current
one and deploy that:

```bash
sh server/scripts/current-digest.sh
# ghcr.io/therehim/tableplanner@sha256:...

kubectl -n lab set image deploy/tableplanner \
  app=$(sh server/scripts/current-digest.sh) \
  migrate=$(sh server/scripts/current-digest.sh)
```

For something that does not move, cut a tag — `git tag v1.0.0 && git push
--tags` — and pin `sh server/scripts/current-digest.sh v1.0.0`, which stays
fixed. **Never `:latest`** — box rule.


### b. Build on the box

No registry at all:

```bash
git clone https://github.com/TheRehim/TablePlanner.git
cd TablePlanner
docker build -f server/Dockerfile -t tableplanner:1 .
```

For k3s, import it into containerd or it will not be found:

```bash
docker save tableplanner:1 | sudo k3s ctr images import -
```

Costs RAM and CPU during the build — check `free -m` first.

### c. Ship a tarball over Tailscale

```bash
docker save tableplanner:1 | gzip > tp.tar.gz
scp tp.tar.gz user@box:/tmp/
ssh user@box 'gunzip -c /tmp/tp.tar.gz | sudo k3s ctr images import -'
```

---

## 2. Database

**Anything in `data/` needs explicit approval — it is shared by every app on
the box.** These are additive; no DDL touches anything that exists.

```sql
CREATE DATABASE tableplanner;
CREATE USER tableplanner WITH PASSWORD '<generated>';
GRANT ALL PRIVILEGES ON DATABASE tableplanner TO tableplanner;
```

Then, from inside the new database:

```sql
GRANT ALL ON SCHEMA public TO tableplanner;
```

(Postgres 15+ revoked public schema creation by default; without this the
migration fails with a permission error.)

Migrations are idempotent and run automatically at container start. To run them
by hand:

```bash
DATABASE_URL='postgres://...' npm run migrate
```

Add the database to the backup job if it uses a named list.

---

## 3. Secrets

Generate them on your own machine. The plaintext password never leaves it:

```bash
cd server && npm run hash-password
```

That prints `EDITOR_PASSWORD_HASH` and a `SESSION_SECRET`. Seal them so only
the cluster can read them — this pipeline keeps the values out of both files
and shell history:

```bash
kubectl -n lab create secret generic tableplanner-secrets \
  --from-literal=DATABASE_URL='postgres://tableplanner:PASS@postgres.data.svc.cluster.local:5432/tableplanner' \
  --from-literal=SESSION_SECRET='...' \
  --from-literal=EDITOR_PASSWORD_HASH='...' \
  --dry-run=client -o yaml \
| kubeseal --format yaml > server/deploy/sealedsecret.yaml

kubectl apply -f server/deploy/sealedsecret.yaml
```

Never `echo` or `cat` these values.

> The hash is `:`-separated, not `$`-separated, precisely so it survives being
> passed through Compose, the shell and `envsubst` without being mangled.

---

## 4. Deploy to `lab/`

`lab/` can be deployed, restarted and deleted freely. Prove it there first.

```bash
kubectl create namespace lab --dry-run=client -o yaml | kubectl apply -f -
kubectl apply --dry-run=server -f server/deploy/deployment.yaml -f server/deploy/service.yaml
kubectl apply -f server/deploy/deployment.yaml -f server/deploy/service.yaml
kubectl -n lab rollout status deploy/tableplanner
```

Reach it over Tailscale — **no Ingress yet**:

```bash
kubectl -n lab port-forward svc/tableplanner 3000:80
```

Then <http://localhost:3000>.

Check it actually fits:

```bash
kubectl top pod -n lab
```

### Why the Service is ClusterIP

On this box NodePort and LoadBalancer **bypass the host firewall**: service
traffic is DNAT'd in PREROUTING and traverses FORWARD, not INPUT, so
`ufw`/`nftables` INPUT rules do not block it. **The Service type is the
firewall decision.** Leave it ClusterIP.

---

## 5. Verify before trusting it

```bash
cd server
BASE=http://localhost:3000 PASSWORD='<the password>' npm run smoke
```

32 checks: auth, cookie tampering, the anonymous-write boundary, optimistic
concurrency, visibility in both directions, that a settings-less write fails
closed, and that live updates are pushed and never carry guest data.

> **The write tests REPLACE the whole board** (they leave one "Smoke Masa"),
> and so does `npm run utf8check`. Both now refuse when the board already has
> masas: smoke runs only its read-only checks and says `SKIP write tests`,
> utf8check exits 2. Set `SMOKE_OVERWRITE=yes` only on an empty or scratch
> database — never on one holding the real guest list. If it happens anyway,
> the previous board is the revision just before `smoke` in `wedding_revision`.

Then confirm by hand, from a **logged-out** browser:

- private → the login card, and `GET /api/state` returns 401
- public → the board is readable but every write is refused
- **live**: open the app in two windows (one logged in), change something in
  one — the other shows it within a second, without a refresh. The badge
  bottom-left says "Canlı deyil" if the live stream is down.
- **live through the proxy** (once there is an Ingress): repeat that over the
  real domain. If the change only shows after a refresh, something in front is
  buffering `GET /api/events`.
- **drag and drop** (logged in, desktop): the purple "Sürüklə: açıq" button is
  in the bottom bar. Drag a guest anywhere onto another masa — including onto
  one of its guests — and that masa goes green and the guest moves there.
  Nothing switches by drag. Click the button: it turns outlined, "Sürüklə:
  bağlı", and rows no longer drag; it stays that way after a reload. On a
  phone it starts off. Needs `code.jquery.com` and `cdn.jsdelivr.net`
  reachable from the browser; without them, editing a guest can still change
  their masa.
- **invitation list** (logged in): tick the box left of a guest's edit
  button; the "Dəvətnamə siyahısı" badge counts it (e.g. `1/113`) and the list
  shows that guest. Untick it in the list — the row's box clears too. Export
  JSON and check the guest has `"invited": true`. A logged-out viewer of a
  public list sees no ticks and no list button.
- **undo + auto-scroll** (logged in, desktop): drag a guest onto another
  masa — a notice appears bottom-right for 5 s; "Geri al" puts the guest back
  in the same row. Drag towards the bottom bar and hold: the page scrolls,
  gently. Releasing over a bar must move nobody.
- **PDF** (logged in): open Siyahı → "PDF göndər". On a phone over HTTPS the
  share sheet opens with the file; on a computer it downloads. Open the PDF
  and check the Azerbaijani letters (ə, ı, ş, ğ). "Sütunlar" toggles change
  the columns in the list, print and PDF alike; default is Qonaq + Masa.
- **phone** (or a window under 768 px): filters start collapsed, drag starts
  off, the bottom bar is one stats line + one row of icons, and ▼ folds it.
  Tap ⋮: the menu (export / import / Excel import) opens fully visible above
  the bar.
- **masa ↔ Qeyd Masası** (logged in): on a guest row press 📝 — the dialog
  preselects the last notes block; Köçür moves the guest there, the masa's
  count and the bottom bar drop by their count, and the block header shows
  `N sətr | N nəfər` one row / their count higher. In Qeyd Masası press 🪑 on a
  row — the last masa is preselected (with a capacity warning if it would go
  over); Köçür seats them and the totals move back.
- **A→Z**: every masa and every Qeyd Masası block reads alphabetically by
  name (ə after e, ı before i). Add a guest whose name starts with "A" to any
  masa, or drag someone in: they appear in their alphabetical place, not at
  the bottom. Qeyd Masası's sort dropdown shows "Ad A→Z" when it opens.

---

## 6. Going public (each step needs approval)

1. Move to the `apps/` namespace.
2. Domain and DNS record.
3. `COOKIE_SECURE=true` in the Deployment — otherwise the session cookie is
   never stored over HTTPS.
4. Ingress + cert-manager certificate (`server/deploy/ingress.yaml.example`).
5. **Decide the visibility deliberately.** It defaults to private. The guest
   list holds real names; `noindex` is already set, but that only asks search
   engines nicely.
6. Restore test: dump → restore into a scratch database → confirm the data is
   real. Never assume a backup is good.

---

## Rollback

```bash
kubectl -n lab rollout undo deploy/tableplanner
```

The data is untouched by a rollback — it lives in Postgres, and every write
also appends to `wedding_revision`, so a bad import can be recovered from
there rather than from a backup.

---

## Operational notes

| | |
|---|---|
| liveness | `/healthz` — deliberately does **not** touch the database, so a DB blip cannot get the pod killed in a loop |
| readiness | `/readyz` — checks Postgres, so traffic stops while the DB is down |
| shutdown | SIGTERM ends the live streams (pages reconnect by themselves), drains connections, closes the pool; 10s hard cap |
| live updates | `GET /api/events` (Server-Sent Events), in-process broadcast — **correct only at `replicas: 1`**. Capped at 500 streams, 20 per client IP |
| filesystem | read-only, with an `emptyDir` at `/tmp` — without it the pod builds fine and crashes at runtime |
| user | non-root (uid 1000) |
| memory | ~18 MiB idle, limit 192Mi |
