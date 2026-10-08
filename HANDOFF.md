# Handoff — deploying TablePlanner on the box

For the next agent, working **on the Linux host** (single-node k3s, Tailscale-only
admin). Everything below was verified on a developer machine, not on the box.
As of writing, **nothing had been deployed to the server** — check
`kubectl get deploy -A | grep tableplanner` before assuming either way; the
steps differ (see "Do this").

Last updated 2026-10-08, for the **invitation status** release: the single
invitation tick becomes four statuses (Dəvət kağız / Dəvət onlayn /
Gəlməyəcək / Qeyd), the Dəvətnamə Siyahısı is grouped by masa with a filter,
Excel export and print, and the **personal invitations** release
(`65d6262` … `f65986f`: `/d/<code>` pages, `invite.html`, designs, pictures)
is **withdrawn** at the user's request. Deploy what `current-digest.sh`
returns now - **not** any build from `65d6262` to `f65986f`, and not
`2c6ce49` (A→Z).

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

Everything since the first handoff, newest first. "new" is this release;
"prev" shipped in the previous images (`4e9a17e` and before; `2c6ce49`'s
A→Z and `65d6262`…`f65986f`'s personal invitations are withdrawn); "earlier"
before that.

| | What | Where |
|---|---|---|
| **new** | **Four invitation statuses instead of one tick.** Each guest has at most one: **Dəvət (kağız)** blue, **Dəvət (onlayn)** green, **Gəlməyəcək** red, **Qeyd** black - or none. Stored as `guest.invite` = `paper` / `online` / `declined` / `note`; no status = the field is absent. Old data converts on load: `invited: true` → `paper`, and `inviteSent: true` (left by the withdrawn release) → `online`; `invited` / `inviteSent` are then dropped, and the converted document is written with the next save. The bottom-bar badge counts the two "Dəvət" statuses: `invited/all`. | `INVITE_STATUSES`, `inviteOf()`, `migrateInvites()` |
| **new** | **Board: four boxes per guest row**, left of 📝 / edit / delete, one per status in its colour. Unchecked boxes are invisible (no fill, no border); hovering the row shows faint outlines; the chosen one is filled with a white ✓. Click a box to set it, click the chosen one again to clear it. **Fast**: a click repaints just that guest's boxes and the badge and saves in the background (~3-5 ms, was ~290 ms when every click redrew all ~480 rows). | `guestActionsHtml()`, `setGuestInvite()`, `paintGuestInvite()`, `scheduleSave()` |
| **new** | **Dəvətnamə Siyahısı reworked.** Grouped by masa in board order (a header row `Masa 3 · 16/18 · 12 qonaq`), guests A→Z inside each masa. Each guest's status is a div dropdown (not a native select), all 170 px, with the status colour as a left bar and soft background. **"Filtr: Hamısı"** (neutral button, default Hamısı; also each status and "Statussuz") only chooses what is shown - it never changes anyone. Counts per status at the top right. Footer: **Bağla**, **Excel-ə ixrac** (SheetJS, masa headers as merged rows) and **Çap Et**, both producing exactly what is on screen - same filter, columns and groups. "PDF göndər" is no longer in this list (still in Siyahı). | `renderInviteList()`, `inviteListTable()`, `exportInviteListExcel()`, `openPickMenu()` |
| **new** | **Personal invitations withdrawn** (the user asked for invitation creation and sharing removed). Gone: `invite.html`, `GET /d/:code`, the ✨ Dəvətnamə dizaynı editor, Hörmət, per-guest links / WhatsApp / pictures, ZIP. **If that release was ever deployed and links were sent, they stop working** (`/d/…` is no longer a route). Its leftovers in the data - `settings.invitation`, `guest.title`, `guest.inviteCode` - are left in place and ignored; nothing reads them. | `server.js`, `Dockerfile` |
| prev | **Card body tinted by state.** The title bar is unchanged (solid blue / dark / red, white text). Below it, the whole card body - rows and the empty space under them - is **light blue `#d3e2ff`** when there are free seats, **light red `#f9d3d3`** when over capacity, and **plain white** when exactly full, so state shows at a glance across the board. Rows are transparent on the tint with a light hairline; hover and search highlights still show on top; the colour follows live as guests move (checked 8/10 blue → 10/10 white → 11/10 red). | CSS `.table-card.cap-* .card-body` |
| prev | **Order by hand, by dragging the row.** One drag does both jobs: drop a guest inside their own masa and they are **reordered**; drop them on another masa and they **move** there. Either way they land where a **green line** shows (above / below a row), not at the bottom. The target masa turns green only when it is a different masa. Hovering a draggable row lights it light-blue with a grab cursor. Buttons and the invite tick inside a row still just click. Undo (5 s "Geri al") covers reorders too. Dropping a row back on its own place does nothing. | `reorderGuest()`, `paintDropSlot()`, `moveGuestTo(…, beforeId)` |
| prev | **Qeyd Masası rows reorder the same way** (whole row, inside its block, with undo) while the block is shown in its saved order ("Əlavə sırası", now the default again). With a sorted view chosen in the dropdown, reordering is off. | `initNoteSorting()` |
| prev | **Automatic A→Z withdrawn.** It was display-only, so reverting it changed no data: every masa shows its saved order again, which is now the order arranged by hand. No timestamps exist or were needed. | `renderTables()` |
| prev | **Masa → Qeyd Masası**: a 📝 button on every guest row (between the tick and edit) parks the guest in a notes block. A small "Köçür" dialog asks which block, **last block preselected**; "+ Yeni blok" is always offered (and preselected when there are none). Name, type and count go across; the invitation tick does not (notes have none). One commit. | `openGuestToNotes()`, `doTransfer()` |
| prev | **Qeyd Masası → masa**: a 🪑 button on every note row seats the note at a masa. The dialog lists masas as `Masa 7 (18/18)`, **last masa preselected**, warns before going over capacity, and asks for a type when the note has none (every guest needs one). Opens on top of the Qeyd Masası window. One commit. | `openNoteToTable()`, `doTransfer()` |
| prev | **Notes totals**: each block header shows `N sətr \| N nəfər`; the window's top line is `N blok \| N sətr \| N nəfər` in the bottom bar's quiet style. Totals count every row, even while a search narrows what is shown. | `noteBlockHtml()` |
| prev | **"PDF göndər"** in both lists (Siyahı, Dəvətnamə siyahısı): a real text PDF built in the browser (jsPDF + autotable, DejaVu Sans embedded for ə/ı/ş/ğ), then the device's **share sheet** (WhatsApp, Telegram, mail…) via Web Share; where that is unavailable it **downloads**. ~115 KB, ~0.2 s. Libraries + font (~1.8 MB) load only when a list opens. | `buildPdf()`, `shareOrDownload()` |
| prev | **List columns**: "Sütunlar: Tip / Say / Masa" toggles in both lists; Qonaq always shown; **default only Qonaq + Masa**. Siyahı gained a Say column (off by default). Screen, print and PDF follow the same choice; kept per device per list (`tp.cols.*`). | `visibleListColumns()` |
| prev | **Undo after drag-and-drop**: a notice bottom-right for 5 s, `"Name" → Masa N [Geri al]`, red if the drop went over capacity. Undo puts the guest back in the same masa and row; refuses (with a message) if the guest or masa changed meanwhile. Only the latest drop is undoable. | `showUndo()`, `undoMove()` |
| prev | **Auto-scroll while dragging** near the top/bottom bars: time-based, eases in, max ~450 px/s at the bar, keeps going while the pointer is still. | `autoScrollStep()` |
| prev | **Fix: a drop over the top/bottom bar no longer lands in the masa hidden behind it** (existed since drag-and-drop shipped). Nothing lights green over a bar. | `pointerOverBars()` |
| prev | Fix: the hovered masa's 3px capacity-coloured top border turns green with the rest (a red/blue strip stayed above the green header). | CSS `.drop-move` |
| prev | **Fix: the ⋮ menu (export / import / Excel import) opened hidden behind the board at phone width.** The phone button row had `overflow: auto`, which clips anything that pops out of it; removed — the buttons share the row and shrink to fit (26 px min, all 10 fit a 320 px phone). | CSS `.bb-actions` |
| prev | **Phone layout**: bottom bar = one stats line with a ▼ toggle that folds the buttons away (remembered), plus one row of icon-only buttons (65 px open, 29 px folded). **Filters start collapsed at phone size**; **drag starts off at phone size**. Phone and desktop sizes keep separate settings and switch live when the window crosses 768 px. | `index.html` |
| prev | Invitation tick (now the four statuses) + "Dəvətnamə siyahısı", Arial, coloured masa title bars, quieter bottom bar. | |
| prev | Drag on/off switch, move-only drag, ⇄ removed from rows, dense board, data-driven card widths, smoke/utf8check overwrite guard. | `initDragDrop()`, `sizeTableColumns()` |
| earlier | Favicon; **live updates** over Server-Sent Events. | `server.js`, `src/live.js` |

**Server changes this release** - only the withdrawal, back to exactly what
`4e9a17e` served: no `/d/:code`, no `invite.html` (the Dockerfile no longer
copies it), and `GET /api/state` no longer strips `inviteCode` (no route uses
codes any more). No schema, migration, env var or manifest change - deploying
is an image swap.

---

## State

**Verified for this release (2026-10-08):**

- On a dev server with a 34-masa / 415-guest board: a box click takes 3-5 ms
  and causes no full redraw; the status is saved (`setInvite`, several quick
  clicks coalesce into one save); the list dropdown repaints in place under
  Hamısı and the row drops out under a status filter; a change from another
  device still shows up live. Old `invited` / `inviteSent` data converted to
  paper / online. Excel export and print match the screen. No console errors.
- On the real image + Postgres 16 via compose (empty database): **32/32 smoke
  checks** and `utf8check` pass; with masas on the board smoke skips its
  writes and utf8check exits 2. `/invite.html` and `/d/abc` return 404; the
  image's `/app/public` holds only `index.html` and `favicon.ico`. In the
  browser: a board seeded with old `invited` / `inviteSent` ticks showed
  paper / online, and the next save wrote `invite` to Postgres with the old
  fields gone; a box click took 2 ms and saved `setInvite`; the list grouped
  by masa (`Masa 1 · 15/14 · 12 qonaq`); clearing a status in the list
  cleared the board box and saved. JSON export → import keeps statuses on
  guests and on Qeyd Masası rows. No console errors.

**Verified locally (2026-09-27, the real image + Postgres 16 via compose):**

- Image builds, runs non-root, no secrets baked in.
- Migrations applied; data **and its version number** survive restarting
  **both** containers.
- **32 smoke checks pass** on an empty board, and `npm run utf8check` passes.
  On a board with masas smoke runs only its 14 read-only checks and skips the
  writes; utf8check refuses.
- In the browser against that stack: a drag-and-drop move saved `moveGuest`,
  the hovered card's top border was green, "Geri al" saved `undoMove` and put
  the guest back in the same row; the list opened with Qonaq + Masa only; a
  PDF built from the real image (fonts from jsDelivr), 112 KB. At phone size
  (375 px): drag off, filters collapsed, bottom bar 65 px with one row of
  icon-only buttons and the ▼ toggle.
- On a separate dev server: the PDF rendered (via pdf.js) with correct
  Azerbaijani letters, ✓ marks and A→Z order; all four send paths behave
  (shared / sheet closed / share refused → download / no Web Share →
  download); auto-scroll measured ~106 px/s half-way into the zone and ~443
  px/s at the bar; a drop over the bottom bar moved nobody; undo refuses when
  the guest moved meanwhile; column toggles drive screen, print and PDF;
  desktop → phone size without reload switched to drag off + filters
  collapsed, and each size kept its own choice after that.
- From earlier releases, still true: invitation list, live updates,
  move-only drops, row buttons click rather than drag, viewers see no edit
  controls.
- Auth: one shared password (scrypt), signed httpOnly cookie.
- Visibility `private` (default) / `public`, **enforced server-side** — private
  returns 401 from `GET /api/state` for anonymous callers.
- SIGTERM with live streams open exits cleanly (code 0). Idles at ~20 MiB.

**Not done / not verified:**

- Never deployed to the box (as of writing).
- Real password not chosen (`npm run hash-password`).
- No Ingress, no TLS, no domain.
- Live updates never tested through Traefik.
- **Touch dragging never tried on a real phone or tablet.** It is off by
  default on phones; a user who switches it on gets Touch Punch's touch-to-mouse
  mapping, which nobody has tried with a finger.
- **The PDF share sheet never seen on a real phone.** Web Share was exercised
  with stand-ins only. It needs **HTTPS** (or localhost): over plain http from
  another device the button downloads the PDF instead — correct, but not the
  share sheet. Once the domain has TLS, try it from a phone.
- **Open choice — 3 or 4 masas per row at 1440 px.** Arial is wider and the
  rows now carry four status boxes, so the narrowest card is ~388 px and a
  1440 px window fits 3 per row (was 4). The cause is one long guest name. The user was offered lowering the
  name cap from 170 to 150 px, or names back to 14px; no answer yet — ask
  before changing either.
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
- By hand: log in, check the board looks dense and cards fill the width, the
  purple "Sürüklə" button and "Dəvətnamə siyahısı" are in the bottom bar, then
  drag a guest onto another masa and back again (two revisions, net no
  change). On one guest click the blue box, then click it again (net no
  change); open Dəvətnamə Siyahısı - grouped by masa, "Filtr: Hamısı".
  The counts at its top right must add up to the guest total.
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
`code.jquery.com`; Bootstrap, Select2, Touch Punch, **jsPDF, jspdf-autotable
and the DejaVu Sans font files** from `cdn.jsdelivr.net`; Font Awesome and
SheetJS (Excel import and "Excel-ə ixrac", loaded on first use) from
`cdnjs.cloudflare.com`. The PDF pieces load only when a list is opened. If
jQuery UI fails to load, drag-and-drop is simply off; if the PDF pieces fail,
"PDF göndər" shows an error and "Çap Et" still works. Browsers need those
hosts; the pod does not. A Content-Security-Policy added later must allow
`cdn.jsdelivr.net` for `script-src` **and** `connect-src` (the fonts are
fetched).

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

**Guests and note rows trade places.** A guest moved to notes becomes
`{ id, name, type, amount }` in the block, plus `invite` if they have a
status; a note seated at a masa becomes a guest with the same id, keeping its
`invite`.
Guest and note ids come from the same counter, so they never collide. Both
moves go through `doTransfer()` and one `commit()` each (`guestToNotes`,
`noteToGuest`). Seated totals count masas only - people parked in notes are
in the notes totals, not "seated".

**Guests carry `invite`** (`paper` / `online` / `declined` / `note`, or
absent). Anything that builds guest objects must keep it: the JSON export
writes it and the JSON import reads it (also the old `invited` /
`inviteSent`), editing a guest changes the object in place so it survives, and
moving keeps the same object. The Excel import creates guests without it,
which correctly means "no status". A new code path that rebuilds guests from
name / type / amount only will silently clear everyone's status.

**Old releases' pages and this data.** An older image's page would read
`invite` as "not invited" (it knows only `invited`); it keeps the field, so
nothing is lost, but its ticks look empty. Don't roll back further than
`4e9a17e` without telling the user.

**Front-end seams — keep them single:**

- `commit(action)` is the only write path. Every mutation is
  `<mutate weddingData>; commit(action)`. `renderApp()` only re-renders — live
  updates call it too — so it must never be used as a write hook. The one
  exception is `scheduleSave(action)`: the same save without the redraw, for a
  change that repaints its own few DOM nodes. Only `setGuestInvite()` uses it;
  anything that changes a count, a masa or a row's place must use `commit()`.
- `reorderGuest()` is the only place a guest changes position inside a masa
  (one commit, `reorderGuest`); `moveGuestTo(..., beforeId)` lands a moved
  guest at a given spot. The board shows `table.guests` in saved order -
  there is no sort at render time any more, so do not add one back without
  asking: the user arranges the order by hand.
- `moveGuestTo()` and `switchGuestsBetween()` are the only places a guest
  changes masa. Drag-and-drop calls `moveGuestTo()` only. The Köçür / Dəyiş
  modal calls both, but has no button any more — the user asked for the
  switch button gone and the function kept. A switch is one commit touching
  both masas, never two.
- The drag switch lives in `dragEnabled` / `setDragEnabled()`; `initDragDrop()`
  does nothing while it is off, for viewers, or if jQuery UI did not load.
- `setGuestInvite()` is the only place a status changes — the board boxes
  and the list dropdowns both call it. It patches the boxes and the badge
  (`paintGuestInvite()`) and saves via `scheduleSave('setInvite')`; the list
  repaints its own dropdown and counts, or redraws itself under a status
  filter.
- `undoMove()` writes through `commit('undoMove')` like any other change and
  only acts if the guest is still where the drop left them.
- Per-device settings live in `localStorage`: `tp.dragEnabled.phone` /
  `.desktop`, `tp.filtersOpen.phone`, `tp.bottomBarCollapsed`, `tp.cols.*`.
  Phone vs desktop is decided by width (under 768 px) or a phone browser, and
  re-applied when the window crosses that line. They are conveniences only —
  nothing about the data lives there.
- `sizeTableColumns()` measures from **all** guests, not the filtered ones, so
  filtering never makes cards jump. It runs on every render and again when the
  icon font finishes loading (button widths depend on it).

**The look is what the user asked for.** Arial; 14px text, 15px guest names
and titles, 13px badges capped at 80px; nothing bold except the masa title
bar, which is solid capacity colour, with the card body below it a lighter
tint of the same state (blue / red, white when full); one-line headers, no
column headers, 4px
gaps; four status boxes per row, invisible until checked (faint outlines on
row hover); the invitation list grouped by masa with a neutral filter
defaulting to Hamısı; move-only drag, no switch button on rows, phones start with drag off and
filters collapsed; a quiet bottom bar with "|" separators and no
"Saxlanıldı"; lists default to Qonaq + Masa; the order inside masas and
notes blocks is the user's own, set by dragging (no automatic sort, no grip
icon - the whole row drags). Do not "restore" defaults or bring removed
things back without asking.

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
