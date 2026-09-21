# TablePlanner

Wedding table and guest planner (Toy Masa İdarəetməsi). Single-page app, Azerbaijani UI.

Arrange guests across masas, watch capacity in real time, move or swap people between
tables, import an existing plan from Excel, and print a guest list for the night.

## Current state

`index.html` is the whole app — one self-contained file, no build step. Open it in a
browser and it runs. Data lives in memory only: **a refresh resets it.** Persistence is
the next step (see below).

External dependencies are all CDN-loaded: jQuery, Bootstrap 5, Select2, FontAwesome,
and SheetJS (lazily, only when an `.xlsx` is actually opened).

## Features

**Masas and guests** — create masas with a capacity, add guests with a party size
(`nəfər`) and a type. Capacity state is colour-coded: blue under capacity, dark at
exactly full, red over.

**Move / switch** — move a guest to another masa, or swap two guests between masas,
with a before/after capacity forecast and validation before you commit.

**Filters** — by masa, name (matches are highlighted in place, the full masa stays
visible), guest type (masa has *any* guest of this type), masa type (*every* guest is
this type), capacity state, and a numeric range applied to party size, occupancy,
capacity or free seats.

**Guest list** — sortable Qonaq / Tip / Masa list with Azerbaijani collation, printable
to paper with repeating headers and no split rows.

**Import / export**
- Export everything as JSON.
- Import JSON (replaces everything, validated and repaired first).
- Import from Excel — either upload the `.xlsx` or paste cells. Three shapes are
  recognised automatically:
  - **Board** — a 2D seating plan where each masa is a header cell like `Masa 7 (18)`
    with guests listed underneath in three columns (Ad, Haradan, Say). Grid geometry is
    detected, not assumed, so any pitch or block size works.
  - **Flat** — `Ad | Haradan | Say | Masa`, one guest per row.
  - **Single** — `Ad | Tip | Say`, one masa.

  Uploading a workbook reads every sheet and keeps whichever yields the most guests.
  `Haradan` maps to the app's `Tip`.

**Read-only mode** — `?view=1` hides every editing control, leaving filtering, the guest
list and printing. **This is presentation only, not a security boundary** — the server
must reject writes from unauthenticated callers.

## Architecture notes for the backend

Every mutation in the app funnels through one function:

```js
<mutate weddingData>;  commit('<what changed>');
```

`commit()` is the only place the app reacts to a write, and nothing else writes.
Wire persistence there and no call site changes. `renderApp()` is read-only re-render
and must never be used as a write hook.

The 13 write actions: `addTable`, `editTable`, `deleteTable`, `addGuest`, `editGuest`,
`deleteGuest`, `moveGuest`, `switchGuests`, `addType`, `renameType`, `deleteType`,
`importData`, `importTable`.

Because there is effectively one editor, the whole dataset moves as a single JSON
document, so `commit()` becomes one `PUT`. Note that `moveGuest` and `switchGuests` each
touch **two** masas — under per-entity endpoints they would need a transaction; as a
single-document write that problem does not arise.

## Licence

Private project.
