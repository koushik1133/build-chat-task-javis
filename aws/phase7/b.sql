-- Phase 7 / Lane B: workforce (staff profiles, shifts/rota, swaps, leave, balances, attendance, payroll export)
-- DSQL rules: no FKs, no triggers, JSON as TEXT, CREATE INDEX ASYNC, one statement per block, no DEFAULT on ADD COLUMN.

-- ── staff_profiles: a person on the rota. May have no login (field crew); membership_id links to a seat when they do.
CREATE TABLE IF NOT EXISTS staff_profiles (
  id               TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL,
  membership_id    TEXT,
  display_name     TEXT NOT NULL,
  email            TEXT,
  phone            TEXT,
  role_title       TEXT,
  employment_type  TEXT NOT NULL DEFAULT 'full_time',   -- full_time|part_time|contractor
  hourly_rate_minor BIGINT NOT NULL DEFAULT 0,
  currency         TEXT NOT NULL DEFAULT 'USD',
  weekly_hours     INTEGER NOT NULL DEFAULT 40,
  skills           TEXT,                                 -- JSON array of strings
  location         TEXT,
  start_date       DATE,
  end_date         DATE,
  active           BOOLEAN NOT NULL DEFAULT TRUE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX ASYNC IF NOT EXISTS idx_staff_profiles_user ON staff_profiles (user_id, active, display_name);

CREATE INDEX ASYNC IF NOT EXISTS idx_staff_profiles_membership ON staff_profiles (user_id, membership_id);

-- ── shifts: one scheduled block of work. staff_id NULL = open/unfilled shift.
CREATE TABLE IF NOT EXISTS shifts (
  id             TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL,
  staff_id       TEXT,
  role_title     TEXT,
  starts_at      TIMESTAMPTZ NOT NULL,
  ends_at        TIMESTAMPTZ NOT NULL,
  break_minutes  INTEGER NOT NULL DEFAULT 0,
  location       TEXT,
  notes          TEXT,
  status         TEXT NOT NULL DEFAULT 'draft',        -- draft|published|confirmed|swapped|cancelled
  published_at   TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX ASYNC IF NOT EXISTS idx_shifts_user_start ON shifts (user_id, starts_at);

CREATE INDEX ASYNC IF NOT EXISTS idx_shifts_user_staff_start ON shifts (user_id, staff_id, starts_at);

-- ── shift_swaps: a request to hand a shift to a colleague.
CREATE TABLE IF NOT EXISTS shift_swaps (
  id             TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL,
  shift_id       TEXT NOT NULL,
  from_staff_id  TEXT NOT NULL,
  to_staff_id    TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'requested',    -- requested|approved|rejected
  note           TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  decided_at     TIMESTAMPTZ
);

CREATE INDEX ASYNC IF NOT EXISTS idx_shift_swaps_user_status ON shift_swaps (user_id, status, created_at);

CREATE INDEX ASYNC IF NOT EXISTS idx_shift_swaps_shift ON shift_swaps (user_id, shift_id);

-- ── leave_requests
CREATE TABLE IF NOT EXISTS leave_requests (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  staff_id    TEXT NOT NULL,
  kind        TEXT NOT NULL DEFAULT 'vacation',       -- vacation|sick|unpaid|other
  starts_on   DATE NOT NULL,
  ends_on     DATE NOT NULL,
  hours       INTEGER NOT NULL DEFAULT 0,
  status      TEXT NOT NULL DEFAULT 'pending',        -- pending|approved|rejected|cancelled
  note        TEXT,
  decided_by  TEXT,
  decided_at  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX ASYNC IF NOT EXISTS idx_leave_requests_user_status ON leave_requests (user_id, status, starts_on);

CREATE INDEX ASYNC IF NOT EXISTS idx_leave_requests_staff ON leave_requests (user_id, staff_id, starts_on);

-- ── leave_balances: per staff / kind / year allotment and usage (hours).
CREATE TABLE IF NOT EXISTS leave_balances (
  user_id         TEXT NOT NULL,
  staff_id        TEXT NOT NULL,
  kind            TEXT NOT NULL,
  year            INTEGER NOT NULL,
  allotted_hours  INTEGER NOT NULL DEFAULT 0,
  used_hours      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, staff_id, kind, year)
);

-- ── attendance: actual clock in/out, from crew links, manual entry or a shift confirmation.
CREATE TABLE IF NOT EXISTS attendance (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  staff_id    TEXT NOT NULL,
  shift_id    TEXT,
  clock_in    TIMESTAMPTZ NOT NULL,
  clock_out   TIMESTAMPTZ,
  source      TEXT NOT NULL DEFAULT 'manual',        -- crew|manual|shift
  minutes     INTEGER,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX ASYNC IF NOT EXISTS idx_attendance_user_in ON attendance (user_id, clock_in);

CREATE INDEX ASYNC IF NOT EXISTS idx_attendance_staff_open ON attendance (user_id, staff_id, clock_out);

-- ── links into existing tables
ALTER TABLE time_entries ADD COLUMN IF NOT EXISTS staff_id TEXT;

ALTER TABLE share_tokens ADD COLUMN IF NOT EXISTS staff_id TEXT;
