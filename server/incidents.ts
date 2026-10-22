import { randomUUID } from "node:crypto";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";

export type ProblemCode = "invalid-token" | "invalid-json" | "invalid-body" | "not-found" | "conflict" | "payload-too-large" | "internal-error";

export class IncidentsError extends Error {
  readonly status: number;
  readonly code: ProblemCode;
  constructor(status: number, code: ProblemCode, detail: string) {
    super(detail);
    this.status = status;
    this.code = code;
  }
}

export type Severity = "critical" | "high" | "medium" | "low";
export type Status = "open" | "investigating" | "mitigated" | "resolved";
export const SEVERITIES: Severity[] = ["critical", "high", "medium", "low"];
export const STATUSES: Status[] = ["open", "investigating", "mitigated", "resolved"];

const PRODUCT = /^[a-z][a-z0-9-]{0,39}$/;
const MAX_PRODUCTS = 12;
const RANK_SQL = `CASE severity WHEN 'critical' THEN 4 WHEN 'high' THEN 3 WHEN 'medium' THEN 2 ELSE 1 END`;

const now = () => new Date().toISOString();
const bad = (detail: string) => new IncidentsError(422, "invalid-body", detail);
const notFound = (what: string) => new IncidentsError(404, "not-found", `${what} does not exist.`);

export interface Page<T> {
  items: T[];
  /** Opaque; pass it back as `cursor` for the next page. Absent on the last page (ADR 0024). */
  nextCursor?: string;
}

const encodeCursor = (offset: number) => Buffer.from(JSON.stringify({ o: offset })).toString("base64url");
function decodeCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  try {
    const o = (JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { o?: unknown }).o;
    if (typeof o === "number" && Number.isSafeInteger(o) && o >= 0) return o;
  } catch {
    // fall through
  }
  throw bad("cursor is not one this API returned.");
}

export function parseLimit(value: string | null, max = 500, fallback = 100): number {
  if (value === null) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > max) throw bad(`limit must be between 1 and ${max}.`);
  return n;
}

const str = (v: unknown, name: string, min: number, max: number): string => {
  if (typeof v !== "string" || v.trim().length < min || v.trim().length > max) throw bad(`${name} must be ${min === 0 ? "at most" : `${min} to`} ${max} characters.`);
  return v.trim();
};
const optStr = (v: unknown, name: string, max: number): string | null => (v === undefined || v === null || v === "" ? null : str(v, name, 1, max));
const oneOf = <T extends string>(v: unknown, name: string, list: readonly T[]): T => {
  if (typeof v !== "string" || !list.includes(v as T)) throw bad(`${name} must be one of ${list.join(", ")}.`);
  return v as T;
};
function productList(v: unknown): string[] {
  if (!Array.isArray(v) || v.length > MAX_PRODUCTS || v.some((p) => typeof p !== "string" || !PRODUCT.test(p))) throw bad(`products is a list of at most ${MAX_PRODUCTS} product ids such as "siem" or "vpn".`);
  return [...new Set(v as string[])];
}
function webUrl(v: unknown): string {
  const u = typeof v === "string" ? URL.parse(v.trim()) : null;
  if (!u || (u.protocol !== "https:" && u.protocol !== "http:") || u.username || u.password) throw bad("url must be a web address starting with http:// or https://, without credentials.");
  return u.href;
}
function exact(body: Record<string, unknown>, allowed: string[]) {
  const extra = Object.keys(body).filter((k) => !allowed.includes(k));
  if (extra.length) throw bad(`Unknown fields: ${extra.join(", ")}. Expected ${allowed.join(", ")}.`);
}

export interface IncidentFilter {
  /** `active` is everything not resolved. */
  status?: Status | "active";
  severity?: Severity[];
  product?: string;
  q?: string;
}

export interface IncidentsOptions {
  /** Resolved incidents older than this are deleted (ADR 0015). */
  retentionDays?: number;
}

export function createIncidents(db: DatabaseSync, { retentionDays = 1095 }: IncidentsOptions = {}) {
  const row = (idOrKey: string) => {
    const m = /^INC-(\d{1,9})$/i.exec(idOrKey);
    const r = (m ? db.prepare("SELECT * FROM incidents WHERE number = ?").get(Number(m[1])) : db.prepare("SELECT * FROM incidents WHERE id = ?").get(idOrKey)) as Record<string, any> | undefined;
    if (!r) throw notFound("The incident");
    return r;
  };

  function log(incidentId: string, kind: string, text: string, author: string) {
    db.prepare("INSERT INTO timeline (incident_id, kind, text, author, at) VALUES (?, ?, ?, ?, ?)").run(incidentId, kind, text, author, now());
  }
  const touch = (id: string) => db.prepare("UPDATE incidents SET updated_at = ? WHERE id = ?").run(now(), id);

  function present(r: Record<string, any>) {
    const open = (db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE incident_id = ? AND done = 0").get(r.id) as { n: number }).n;
    return {
      id: r.id as string,
      key: `INC-${r.number}`,
      number: r.number as number,
      title: r.title as string,
      severity: r.severity as Severity,
      status: r.status as Status,
      commander: (r.commander as string | null) ?? null,
      summary: r.summary as string,
      products: JSON.parse(r.products) as string[],
      external: r.ext_source ? { source: r.ext_source as string, reference: r.ext_ref as string } : null,
      openTasks: open,
      createdAt: r.created_at as string,
      updatedAt: r.updated_at as string,
      resolvedAt: (r.resolved_at as string | null) ?? null,
    };
  }

  function detail(r: Record<string, any>) {
    const pm = db.prepare("SELECT * FROM postmortems WHERE incident_id = ?").get(r.id) as Record<string, any> | undefined;
    return {
      ...present(r),
      timeline: (db.prepare("SELECT * FROM timeline WHERE incident_id = ? ORDER BY id").all(r.id) as Array<Record<string, any>>).map((t) => ({ id: t.id as number, kind: t.kind as string, text: t.text as string, author: t.author as string, at: t.at as string })),
      tasks: (db.prepare("SELECT * FROM tasks WHERE incident_id = ? ORDER BY created_at, rowid").all(r.id) as Array<Record<string, any>>).map(presentTask),
      evidence: (db.prepare("SELECT * FROM evidence WHERE incident_id = ? ORDER BY created_at, rowid").all(r.id) as Array<Record<string, any>>).map((e) => ({ id: e.id as string, title: e.title as string, url: e.url as string, source: (e.source as string | null) ?? null, createdAt: e.created_at as string })),
      postmortem: pm ? { body: pm.body as string, status: pm.status as "draft" | "published", updatedAt: pm.updated_at as string, updatedBy: pm.updated_by as string, publishedAt: (pm.published_at as string | null) ?? null } : null,
    };
  }

  function presentTask(t: Record<string, any>) {
    return { id: t.id as string, title: t.title as string, owner: (t.owner as string | null) ?? null, done: t.done === 1, due: (t.due as string | null) ?? null, createdAt: t.created_at as string };
  }

  function dueDate(v: unknown): string | null {
    if (v === undefined || v === null || v === "") return null;
    const t = typeof v === "string" ? Date.parse(v) : NaN;
    if (Number.isNaN(t)) throw bad("due must be a date.");
    return new Date(t).toISOString();
  }

  return {
    /**
     * Opens an incident. When another product names the same source and reference again, no second incident is
     * opened: the report is added to the first one's timeline and `created` is false.
     */
    create(body: Record<string, unknown>, actor: string) {
      exact(body, ["title", "severity", "commander", "summary", "products", "external"]);
      const title = str(body.title, "title", 3, 200);
      const severity = body.severity === undefined ? "medium" : oneOf(body.severity, "severity", SEVERITIES);
      const commander = optStr(body.commander, "commander", 100);
      const summary = body.summary === undefined ? "" : str(body.summary, "summary", 0, 5000);
      const products = body.products === undefined ? [] : productList(body.products);
      let external: { source: string; reference: string } | null = null;
      if (body.external !== undefined) {
        const e = body.external as Record<string, unknown> | null;
        if (!e || typeof e !== "object" || Array.isArray(e)) throw bad("external is { source, reference }.");
        exact(e, ["source", "reference"]);
        external = { source: str(e.source, "external.source", 1, 64), reference: str(e.reference, "external.reference", 1, 256) };
      }

      db.exec("BEGIN IMMEDIATE");
      try {
        if (external) {
          const same = db.prepare("SELECT * FROM incidents WHERE ext_source = ? AND ext_ref = ?").get(external.source, external.reference) as Record<string, any> | undefined;
          if (same) {
            log(same.id, "note", `Reported again by ${external.source}${summary ? `: ${summary}` : "."}`, actor);
            touch(same.id);
            db.exec("COMMIT");
            return { created: false, incident: detail(row(same.id)) };
          }
        }
        const id = randomUUID();
        const number = ((db.prepare("SELECT COALESCE(MAX(number), 0) AS n FROM incidents").get() as { n: number }).n) + 1;
        const at = now();
        db.prepare("INSERT INTO incidents (id, number, title, severity, status, commander, summary, products, ext_source, ext_ref, created_at, updated_at) VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?)").run(
          id, number, title, severity, commander, summary, JSON.stringify(products), external?.source ?? null, external?.reference ?? null, at, at,
        );
        log(id, "note", external ? `Opened by ${external.source}.` : "Incident opened.", actor);
        db.exec("COMMIT");
        return { created: true, incident: detail(row(id)) };
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    },

    list(filter: IncidentFilter, cursor: string | undefined, limit: number): Page<ReturnType<typeof present>> {
      const where: string[] = [];
      const args: SQLInputValue[] = [];
      if (filter.status === "active") where.push("status <> 'resolved'");
      else if (filter.status) (where.push("status = ?"), args.push(filter.status));
      if (filter.severity?.length) (where.push(`severity IN (${filter.severity.map(() => "?").join(",")})`), args.push(...filter.severity));
      if (filter.product) (where.push("EXISTS (SELECT 1 FROM json_each(incidents.products) WHERE value = ?)"), args.push(filter.product));
      if (filter.q) {
        const like = `%${filter.q.replace(/[\\%_]/g, "\\$&")}%`;
        where.push("(title LIKE ? ESCAPE '\\' OR summary LIKE ? ESCAPE '\\' OR commander LIKE ? ESCAPE '\\' OR ('INC-' || number) LIKE ? ESCAPE '\\')");
        args.push(like, like, like, like);
      }
      const offset = decodeCursor(cursor);
      const rows = db
        .prepare(`SELECT * FROM incidents ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY (status = 'resolved'), ${RANK_SQL} DESC, created_at DESC LIMIT ? OFFSET ?`)
        .all(...args, limit + 1, offset) as Array<Record<string, any>>;
      return { items: rows.slice(0, limit).map(present), ...(rows.length > limit && { nextCursor: encodeCursor(offset + limit) }) };
    },

    get: (id: string) => detail(row(id)),

    /** Changes an incident. A change of status or severity is written to the timeline by itself. */
    update(id: string, body: Record<string, unknown>, actor: string) {
      const r = row(id);
      exact(body, ["title", "severity", "status", "commander", "summary", "products"]);
      if (!Object.keys(body).length) throw bad("Send at least one of title, severity, status, commander, summary, products.");
      const sets: string[] = [];
      const args: SQLInputValue[] = [];
      const set = (col: string, v: SQLInputValue) => (sets.push(`${col} = ?`), args.push(v));
      if (body.title !== undefined) set("title", str(body.title, "title", 3, 200));
      if (body.summary !== undefined) set("summary", str(body.summary, "summary", 0, 5000));
      if (body.commander !== undefined) set("commander", optStr(body.commander, "commander", 100));
      if (body.products !== undefined) set("products", JSON.stringify(productList(body.products)));
      const severity = body.severity === undefined ? undefined : oneOf(body.severity, "severity", SEVERITIES);
      const status = body.status === undefined ? undefined : oneOf(body.status, "status", STATUSES);
      db.exec("BEGIN IMMEDIATE");
      try {
        if (severity && severity !== r.severity) {
          set("severity", severity);
          log(r.id, "severity-change", `Severity changed from ${r.severity} to ${severity}.`, actor);
        }
        if (status && status !== r.status) {
          set("status", status);
          // Resolving closes the clock; reopening starts it again.
          set("resolved_at", status === "resolved" ? now() : null);
          log(r.id, "status-change", `Status changed from ${r.status} to ${status}.`, actor);
        }
        set("updated_at", now());
        db.prepare(`UPDATE incidents SET ${sets.join(", ")} WHERE id = ?`).run(...args, r.id);
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
      return detail(row(r.id));
    },

    delete(id: string) {
      const r = row(id);
      db.prepare("DELETE FROM incidents WHERE id = ?").run(r.id);
    },

    addTimeline(id: string, body: Record<string, unknown>, actor: string) {
      const r = row(id);
      exact(body, ["kind", "text"]);
      const kind = body.kind === undefined ? "note" : oneOf(body.kind, "kind", ["note", "link"] as const);
      log(r.id, kind, str(body.text, "text", 1, 2000), actor);
      touch(r.id);
      return detail(row(r.id));
    },

    addTask(id: string, body: Record<string, unknown>) {
      const r = row(id);
      exact(body, ["title", "owner", "due"]);
      db.prepare("INSERT INTO tasks (id, incident_id, title, owner, due, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(randomUUID(), r.id, str(body.title, "title", 1, 300), optStr(body.owner, "owner", 100), dueDate(body.due), now());
      touch(r.id);
      return detail(row(r.id));
    },

    updateTask(id: string, taskId: string, body: Record<string, unknown>, actor: string) {
      const r = row(id);
      const t = db.prepare("SELECT * FROM tasks WHERE id = ? AND incident_id = ?").get(taskId, r.id) as Record<string, any> | undefined;
      if (!t) throw notFound("The task");
      exact(body, ["title", "owner", "due", "done"]);
      if (!Object.keys(body).length) throw bad("Send at least one of title, owner, due, done.");
      if (body.done !== undefined && typeof body.done !== "boolean") throw bad("done must be true or false.");
      db.prepare("UPDATE tasks SET title = ?, owner = ?, due = ?, done = ? WHERE id = ?").run(
        body.title === undefined ? t.title : str(body.title, "title", 1, 300),
        body.owner === undefined ? t.owner : optStr(body.owner, "owner", 100),
        body.due === undefined ? t.due : dueDate(body.due),
        body.done === undefined ? t.done : body.done ? 1 : 0,
        t.id,
      );
      if (body.done === true && t.done === 0) log(r.id, "task-done", `Task done: ${t.title}`, actor);
      touch(r.id);
      return detail(row(r.id));
    },

    deleteTask(id: string, taskId: string) {
      const r = row(id);
      if (db.prepare("DELETE FROM tasks WHERE id = ? AND incident_id = ?").run(taskId, r.id).changes === 0) throw notFound("The task");
      touch(r.id);
    },

    addEvidence(id: string, body: Record<string, unknown>) {
      const r = row(id);
      exact(body, ["title", "url", "source"]);
      const source = body.source === undefined || body.source === null ? null : str(body.source, "source", 1, 40);
      if (source !== null && !PRODUCT.test(source)) throw bad('source is the product the evidence lives in, such as "logs".');
      db.prepare("INSERT INTO evidence (id, incident_id, title, url, source, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(randomUUID(), r.id, str(body.title, "title", 1, 200), webUrl(body.url), source, now());
      touch(r.id);
      return detail(row(r.id));
    },

    deleteEvidence(id: string, evidenceId: string) {
      const r = row(id);
      if (db.prepare("DELETE FROM evidence WHERE id = ? AND incident_id = ?").run(evidenceId, r.id).changes === 0) throw notFound("The evidence");
      touch(r.id);
    },

    /** The postmortem is written once the incident is over, so it can say how it ended. */
    putPostmortem(id: string, body: Record<string, unknown>, actor: string) {
      const r = row(id);
      exact(body, ["body", "status"]);
      if (r.status !== "resolved") throw new IncidentsError(409, "conflict", "A postmortem is written once the incident is resolved.");
      const text = str(body.body, "body", 0, 50_000);
      const status = body.status === undefined ? "draft" : oneOf(body.status, "status", ["draft", "published"] as const);
      if (status === "published" && text.length < 10) throw bad("A published postmortem needs a body.");
      const before = db.prepare("SELECT status, published_at FROM postmortems WHERE incident_id = ?").get(r.id) as { status: string; published_at: string | null } | undefined;
      const publishedAt = status === "published" ? (before?.published_at ?? now()) : null;
      db.prepare(
        `INSERT INTO postmortems (incident_id, body, status, updated_at, updated_by, published_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (incident_id) DO UPDATE SET body = excluded.body, status = excluded.status, updated_at = excluded.updated_at, updated_by = excluded.updated_by, published_at = excluded.published_at`,
      ).run(r.id, text, status, now(), actor, publishedAt);
      if (status === "published" && before?.status !== "published") log(r.id, "note", "Postmortem published.", actor);
      touch(r.id);
      return detail(row(r.id));
    },

    summary() {
      const open = { critical: 0, high: 0, medium: 0, low: 0 } as Record<Severity, number>;
      for (const r of db.prepare("SELECT severity, COUNT(*) AS n FROM incidents WHERE status <> 'resolved' GROUP BY severity").all() as Array<{ severity: Severity; n: number }>) open[r.severity] = r.n;
      const since = new Date(Date.now() - 90 * 86_400_000).toISOString();
      const mttr = db.prepare("SELECT AVG((julianday(resolved_at) - julianday(created_at)) * 1440) AS m, COUNT(*) AS n FROM incidents WHERE resolved_at IS NOT NULL AND resolved_at > ?").get(since) as { m: number | null; n: number };
      const awaiting = (db.prepare("SELECT COUNT(*) AS n FROM incidents i WHERE status = 'resolved' AND NOT EXISTS (SELECT 1 FROM postmortems p WHERE p.incident_id = i.id AND p.status = 'published')").get() as { n: number }).n;
      return {
        open,
        total: (db.prepare("SELECT COUNT(*) AS n FROM incidents").get() as { n: number }).n,
        resolved90d: mttr.n,
        meanMinutesToResolve: mttr.m === null ? null : Math.round(mttr.m),
        awaitingPostmortem: awaiting,
      };
    },

    purge() {
      const before = new Date(Date.now() - retentionDays * 86_400_000).toISOString();
      db.prepare("DELETE FROM incidents WHERE resolved_at IS NOT NULL AND resolved_at < ?").run(before);
    },
  };
}

export type Incidents = ReturnType<typeof createIncidents>;
