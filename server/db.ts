import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

// Forward-only migrations (ADR 0010): append new entries, never edit or remove old ones.
const MIGRATIONS = [
  `CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
   -- number is the INC-n people say out loud. ext_source and ext_ref are set when another product opened the incident:
   -- the same pair opens one incident, however often it is reported.
   CREATE TABLE incidents (
     id TEXT PRIMARY KEY,
     number INTEGER NOT NULL UNIQUE,
     title TEXT NOT NULL,
     severity TEXT NOT NULL CHECK (severity IN ('critical', 'high', 'medium', 'low')),
     status TEXT NOT NULL CHECK (status IN ('open', 'investigating', 'mitigated', 'resolved')),
     commander TEXT,
     summary TEXT NOT NULL DEFAULT '',
     products TEXT NOT NULL DEFAULT '[]',
     ext_source TEXT,
     ext_ref TEXT,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL,
     resolved_at TEXT
   );
   CREATE UNIQUE INDEX incidents_external ON incidents (ext_source, ext_ref) WHERE ext_source IS NOT NULL;
   CREATE INDEX incidents_status ON incidents (status, created_at DESC);
   -- Append-only: nothing is edited or deleted, so the timeline can be trusted afterwards.
   CREATE TABLE timeline (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     incident_id TEXT NOT NULL REFERENCES incidents (id) ON DELETE CASCADE,
     kind TEXT NOT NULL CHECK (kind IN ('note', 'status-change', 'severity-change', 'link', 'task-done')),
     text TEXT NOT NULL,
     author TEXT NOT NULL,
     at TEXT NOT NULL
   );
   CREATE INDEX timeline_incident ON timeline (incident_id, id);
   CREATE TABLE tasks (
     id TEXT PRIMARY KEY,
     incident_id TEXT NOT NULL REFERENCES incidents (id) ON DELETE CASCADE,
     title TEXT NOT NULL,
     owner TEXT,
     done INTEGER NOT NULL DEFAULT 0,
     due TEXT,
     created_at TEXT NOT NULL
   );
   CREATE INDEX tasks_incident ON tasks (incident_id);
   -- Links to where the evidence lives; no files are kept (ADR 0041).
   CREATE TABLE evidence (
     id TEXT PRIMARY KEY,
     incident_id TEXT NOT NULL REFERENCES incidents (id) ON DELETE CASCADE,
     title TEXT NOT NULL,
     url TEXT NOT NULL,
     source TEXT,
     created_at TEXT NOT NULL
   );
   CREATE INDEX evidence_incident ON evidence (incident_id);
   CREATE TABLE postmortems (
     incident_id TEXT PRIMARY KEY REFERENCES incidents (id) ON DELETE CASCADE,
     body TEXT NOT NULL,
     status TEXT NOT NULL CHECK (status IN ('draft', 'published')),
     updated_at TEXT NOT NULL,
     updated_by TEXT NOT NULL,
     published_at TEXT
   )`,
];

/** Opens the product's single SQLite file in WAL mode (ADR 0011) and migrates it forward. */
export function openDb(path: string): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
  const row = db.prepare("SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations").get() as { v: number };
  for (let v = row.v; v < MIGRATIONS.length; v++) {
    db.exec("BEGIN");
    try {
      db.exec(MIGRATIONS[v]!);
      db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(v + 1, new Date().toISOString());
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }
  return db;
}
