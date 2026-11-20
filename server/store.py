"""SQLite store: action workflow events, field reports, pipeline runs.

Append-only on purpose: the action log is an audit trail (who proposed,
who approved, when), so the current step is derived from the events rather
than stored and overwritten.
"""

import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone

SCHEMA = """
CREATE TABLE IF NOT EXISTS events (
  id         INTEGER PRIMARY KEY,
  period_id  TEXT NOT NULL,
  kec_id     TEXT NOT NULL,
  kind       TEXT NOT NULL CHECK (kind IN ('step', 'reset')),
  step       TEXT NOT NULL,
  actor      TEXT NOT NULL,
  role       TEXT NOT NULL,
  note       TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_period ON events (period_id, kec_id, id);

CREATE TABLE IF NOT EXISTS reports (
  id         INTEGER PRIMARY KEY,
  period_id  TEXT NOT NULL,
  kec_id     TEXT NOT NULL,
  desa_id    TEXT,
  answer     TEXT NOT NULL,
  note       TEXT,
  actor      TEXT NOT NULL,
  role       TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS reports_kec ON reports (kec_id, id);

CREATE TABLE IF NOT EXISTS runs (
  id          INTEGER PRIMARY KEY,
  job         TEXT NOT NULL,
  trigger     TEXT NOT NULL,
  started_at  TEXT NOT NULL,
  finished_at TEXT,
  status      TEXT NOT NULL CHECK (status IN ('running', 'ok', 'failed')),
  log_tail    TEXT
);
"""


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


class Store:
    def __init__(self, path):
        self.path = str(path)
        c = sqlite3.connect(self.path, timeout=10)
        try:
            c.executescript(SCHEMA)  # commits on its own
        finally:
            c.close()
        with self.conn(write=True) as c:
            # A server killed mid-run leaves 'running' rows behind
            c.execute("UPDATE runs SET status='failed', finished_at=?, log_tail=coalesce(log_tail,'') || "
                      "'\n[server restarted during run]' WHERE status='running'", (now(),))

    @contextmanager
    def conn(self, write=False):
        """write=True takes the write lock up front (BEGIN IMMEDIATE), so a
        check-then-insert (read the current step, then add the next one) is
        atomic: a second writer waits here and then sees the first one's row.
        Python's default only begins the transaction at the INSERT, which let
        two simultaneous clicks both pass the check."""
        c = sqlite3.connect(self.path, timeout=10, isolation_level=None)
        c.row_factory = sqlite3.Row
        try:
            c.execute("PRAGMA journal_mode=WAL")
            c.execute("BEGIN IMMEDIATE" if write else "BEGIN")
            try:
                yield c
            except BaseException:
                c.execute("ROLLBACK")
                raise
            c.execute("COMMIT")
        finally:
            c.close()

    # ------------------------------------------------------------ workflow
    def current_step(self, c, period_id, kec_id) -> str:
        r = c.execute("SELECT kind, step FROM events WHERE period_id=? AND kec_id=? "
                      "ORDER BY id DESC LIMIT 1", (period_id, kec_id)).fetchone()
        return "open" if r is None or r["kind"] == "reset" else r["step"]

    def add_event(self, c, period_id, kec_id, kind, step, actor, role, note=None):
        c.execute("INSERT INTO events (period_id, kec_id, kind, step, actor, role, note, created_at) "
                  "VALUES (?,?,?,?,?,?,?,?)", (period_id, kec_id, kind, step, actor, role, note, now()))

    def events(self, period_id):
        with self.conn() as c:
            return [dict(r) for r in c.execute(
                "SELECT * FROM events WHERE period_id=? ORDER BY id", (period_id,))]

    # ------------------------------------------------------------ reports
    def add_report(self, period_id, kec_id, desa_id, answer, note, actor, role):
        with self.conn() as c:
            cur = c.execute(
                "INSERT INTO reports (period_id, kec_id, desa_id, answer, note, actor, role, created_at) "
                "VALUES (?,?,?,?,?,?,?,?)", (period_id, kec_id, desa_id, answer, note, actor, role, now()))
            return dict(c.execute("SELECT * FROM reports WHERE id=?", (cur.lastrowid,)).fetchone())

    def reports(self, kec_id=None):
        q, args = "SELECT * FROM reports", ()
        if kec_id:
            q, args = q + " WHERE kec_id=?", (kec_id,)
        with self.conn() as c:
            return [dict(r) for r in c.execute(q + " ORDER BY id DESC", args)]

    # ------------------------------------------------------------ runs
    def start_run(self, job, trigger) -> int:
        with self.conn() as c:
            return c.execute("INSERT INTO runs (job, trigger, started_at, status) VALUES (?,?,?, 'running')",
                             (job, trigger, now())).lastrowid

    def finish_run(self, run_id, ok, log_tail):
        with self.conn() as c:
            c.execute("UPDATE runs SET finished_at=?, status=?, log_tail=? WHERE id=?",
                      (now(), "ok" if ok else "failed", log_tail, run_id))

    def last_run(self, job, status=None):
        q, args = "SELECT * FROM runs WHERE job=?", [job]
        if status:
            q += " AND status=?"
            args.append(status)
        with self.conn() as c:
            r = c.execute(q + " ORDER BY id DESC LIMIT 1", args).fetchone()
            return dict(r) if r else None

    def runs(self, limit=20):
        with self.conn() as c:
            return [dict(r) for r in c.execute("SELECT * FROM runs ORDER BY id DESC LIMIT ?", (limit,))]
