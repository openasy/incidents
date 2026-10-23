import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDb } from "./db.ts";

describe("openDb", () => {
  it("uses WAL and migrates once", () => {
    const path = join(mkdtempSync(join(tmpdir(), "incidents-")), "nested", "incidents.db");
    const first = openDb(path);
    expect(first.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
    first.close();

    const second = openDb(path);
    expect(second.prepare("SELECT COUNT(*) AS n FROM schema_migrations").get()).toEqual({ n: 1 });
    second.close();
  });

  it("deletes an incident's timeline, tasks, evidence and postmortem with it", () => {
    const db = openDb(":memory:");
    db.exec(`INSERT INTO incidents (id, number, title, severity, status, created_at, updated_at) VALUES ('i', 1, 'x', 'high', 'resolved', 'now', 'now');
      INSERT INTO timeline (incident_id, kind, text, author, at) VALUES ('i', 'note', 't', 'a', 'now');
      INSERT INTO tasks (id, incident_id, title, created_at) VALUES ('t', 'i', 't', 'now');
      INSERT INTO evidence (id, incident_id, title, url, created_at) VALUES ('e', 'i', 't', 'https://x.example.com', 'now');
      INSERT INTO postmortems VALUES ('i', 'b', 'draft', 'now', 'a', NULL);
      DELETE FROM incidents`);
    expect(
      db
        .prepare(
          "SELECT (SELECT COUNT(*) FROM timeline) + (SELECT COUNT(*) FROM tasks) + (SELECT COUNT(*) FROM evidence) + (SELECT COUNT(*) FROM postmortems) AS n",
        )
        .get(),
    ).toEqual({ n: 0 });
  });

  it("refuses a second incident for the same external report", () => {
    const db = openDb(":memory:");
    const add = (n: number) =>
      db.exec(
        `INSERT INTO incidents (id, number, title, severity, status, ext_source, ext_ref, created_at, updated_at) VALUES ('i${n}', ${n}, 'x', 'high', 'open', 'siem', 'sig-1', 'now', 'now')`,
      );
    add(1);
    expect(() => add(2)).toThrow(/UNIQUE/);
  });
});
