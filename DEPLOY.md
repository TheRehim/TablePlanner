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

The package starts **private**. Either make it public once —
*GitHub → Packages → tableplanner → Package settings → Change visibility* — or
keep it private and create a pull secret:

```bash
kubectl -n lab create secret docker-registry ghcr \
  --docker-server=ghcr.io \
  --docker-username=TheRehim \
  --docker-password='<a PAT with read:packages>'
```

Then add `imagePullSecrets: [{name: ghcr}]` to the pod spec.

Take the digest from the Actions run summary and pin it in
`server/deploy/deployment.yaml`. **Never `:latest`** — box rule.

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

25 checks: auth, cookie tampering, the anonymous-write boundary, optimistic
concurrency, visibility in both directions, and that a settings-less write
fails closed.

Then confirm by hand, from a **logged-out** browser:

- private → the login card, and `GET /api/state` returns 401
- public → the board is readable but every write is refused

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
| shutdown | SIGTERM drains connections, then closes the pool; 10s hard cap |
| filesystem | read-only, with an `emptyDir` at `/tmp` — without it the pod builds fine and crashes at runtime |
| user | non-root (uid 1000) |
| memory | ~18 MiB idle, limit 192Mi |
