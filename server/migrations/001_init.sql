-- TablePlanner schema.
--
-- The whole planner is one JSONB document. This is deliberate: there is
-- effectively one editor, and moveGuest / switchGuests each touch two masas at
-- once, which as a single-document write needs no cross-row transaction.
--
-- Safe to run more than once.

CREATE TABLE IF NOT EXISTS wedding_state (
    id         int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    data       jsonb       NOT NULL,
    version    int         NOT NULL DEFAULT 1,
    updated_at timestamptz NOT NULL DEFAULT now()
);

-- Append-only history: the undo trail, and the safety net for a bad import.
CREATE TABLE IF NOT EXISTS wedding_revision (
    id         bigserial PRIMARY KEY,
    data       jsonb       NOT NULL,
    action     text,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS wedding_revision_created_idx
    ON wedding_revision (created_at DESC);

-- Seed the single state row. ON CONFLICT keeps an existing document intact,
-- so re-running this migration can never wipe live data.
INSERT INTO wedding_state (id, data, version)
VALUES (1, '{"guestTypes":["Dost"],"tables":[],"notes":[]}'::jsonb, 1)
ON CONFLICT (id) DO NOTHING;
