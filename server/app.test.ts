import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startApp } from "./test-app.ts";

let app: Awaited<ReturnType<typeof startApp>>;
beforeAll(async () => {
  app = await startApp({ version: "0.1.0" });
});
afterAll(() => app.close());

const json = async (res: Response) => (await res.json()) as any;
const open = async (body: Record<string, unknown>) => json(await app.send("POST", "/api/v1/incidents", body));
const status = (p: Promise<Response>) => p.then((r) => r.status);

describe("opening and listing", () => {
  it("numbers incidents in order and writes the first timeline entry", async () => {
    const a = await open({ title: "Checkout is down", severity: "critical", commander: "Aylin", products: ["uptime", "logs"] });
    expect(a).toMatchObject({
      key: "INC-1",
      number: 1,
      status: "open",
      severity: "critical",
      commander: "Aylin",
      products: ["uptime", "logs"],
      external: null,
      openTasks: 0,
      resolvedAt: null,
    });
    expect(a.timeline).toMatchObject([{ kind: "note", text: "Incident opened.", author: "admin token" }]);
    const b = await open({ title: "Slow reports" });
    expect(b).toMatchObject({ key: "INC-2", severity: "medium", commander: null, summary: "" });
  });

  it("finds an incident by its id or its INC number", async () => {
    const a = await json(await app.send("GET", "/api/v1/incidents/INC-1"));
    expect(a.title).toBe("Checkout is down");
    expect((await json(await app.send("GET", `/api/v1/incidents/${a.id}`))).key).toBe("INC-1");
    expect((await json(await app.send("GET", "/api/v1/incidents/inc-2"))).key).toBe("INC-2");
    expect(await status(app.send("GET", "/api/v1/incidents/INC-99"))).toBe(404);
  });

  it("lists the most serious active incident first, and filters", async () => {
    await open({ title: "Phishing mail reported", severity: "high", products: ["siem"], summary: "Finance got a fake invoice" });
    const all = await json(await app.send("GET", "/api/v1/incidents"));
    expect(all.incidents.map((i: { key: string }) => i.key)).toEqual(["INC-1", "INC-3", "INC-2"]);
    const q = async (query: string) => (await json(await app.send("GET", `/api/v1/incidents?${query}`))).incidents.map((i: { key: string }) => i.key);
    expect(await q("severity=high,critical")).toEqual(["INC-1", "INC-3"]);
    expect(await q("product=siem")).toEqual(["INC-3"]);
    expect(await q("q=invoice")).toEqual(["INC-3"]);
    expect(await q("q=inc-2")).toEqual(["INC-2"]);
    expect(await q("q=%25")).toEqual([]);
    expect(await q("status=active")).toHaveLength(3);
    const page = await json(await app.send("GET", "/api/v1/incidents?limit=2"));
    expect(page.incidents).toHaveLength(2);
    expect((await json(await app.send("GET", `/api/v1/incidents?limit=2&cursor=${page.nextCursor}`))).incidents).toHaveLength(1);
    for (const bad of ["status=gone", "severity=urgent", "product=BAD", "limit=0", "cursor=junk"])
      expect(await status(app.send("GET", `/api/v1/incidents?${bad}`))).toBe(422);
  });

  it("refuses what is not an incident", async () => {
    for (const body of [
      {},
      { title: "ab" },
      { title: "ok title", severity: "urgent" },
      { title: "ok title", products: ["Bad Id"] },
      { title: "ok title", extra: 1 },
      { title: "ok title", external: "x" },
      { title: "ok title", external: { source: "siem" } },
    ]) {
      expect(await status(app.send("POST", "/api/v1/incidents", body)), JSON.stringify(body)).toBe(422);
    }
    expect(await status(app.admin("/api/v1/incidents", { method: "POST", body: "{nope" }))).toBe(400);
  });
});

describe("another product reports", () => {
  it("opens one incident for the same source and reference, and adds to its timeline the second time", async () => {
    const first = await app.send("POST", "/api/v1/incidents", {
      title: "Brute force on vpn",
      severity: "high",
      external: { source: "siem", reference: "sig-42" },
    });
    expect(first.status).toBe(201);
    const a = await json(first);
    expect(a.external).toEqual({ source: "siem", reference: "sig-42" });
    expect(a.timeline[0].text).toBe("Opened by siem.");
    const second = await app.send("POST", "/api/v1/incidents", {
      title: "Brute force on vpn",
      external: { source: "siem", reference: "sig-42" },
      summary: "40 more failures",
    });
    expect(second.status).toBe(200);
    const b = await json(second);
    expect(b.id).toBe(a.id);
    expect(b.timeline.map((t: { text: string }) => t.text)).toEqual(["Opened by siem.", "Reported again by siem: 40 more failures"]);
    // Another reference is another incident.
    expect((await app.send("POST", "/api/v1/incidents", { title: "Brute force on vpn", external: { source: "siem", reference: "sig-43" } })).status).toBe(201);
  });
});

describe("running an incident", () => {
  it("writes status and severity changes to the timeline by itself, and keeps the clock", async () => {
    const before = await json(await app.send("GET", "/api/v1/incidents/INC-1"));
    const step = await json(await app.send("PATCH", "/api/v1/incidents/INC-1", { status: "investigating", severity: "high", commander: "Mert" }));
    expect(step).toMatchObject({ status: "investigating", severity: "high", commander: "Mert", resolvedAt: null });
    expect(step.timeline.slice(before.timeline.length).map((t: { kind: string; text: string }) => [t.kind, t.text])).toEqual([
      ["severity-change", "Severity changed from critical to high."],
      ["status-change", "Status changed from open to investigating."],
    ]);
    // Saying the same thing again writes nothing.
    const same = await json(await app.send("PATCH", "/api/v1/incidents/INC-1", { status: "investigating" }));
    expect(same.timeline).toHaveLength(step.timeline.length);
    const done = await json(await app.send("PATCH", "/api/v1/incidents/INC-1", { status: "resolved" }));
    expect(done.resolvedAt).toEqual(expect.any(String));
    const reopened = await json(await app.send("PATCH", "/api/v1/incidents/INC-1", { status: "open" }));
    expect(reopened.resolvedAt).toBeNull();
    await app.send("PATCH", "/api/v1/incidents/INC-1", { status: "resolved", title: "Checkout was down", summary: "A bad deploy" });
  });

  it("refuses bad changes", async () => {
    for (const body of [{}, { status: "closed" }, { severity: "urgent" }, { title: "x" }, { products: "siem" }, { extra: 1 }])
      expect(await status(app.send("PATCH", "/api/v1/incidents/INC-2", body)), JSON.stringify(body)).toBe(422);
    expect(await status(app.send("PATCH", "/api/v1/incidents/INC-99", { status: "open" }))).toBe(404);
  });

  it("keeps notes and links, which nobody can edit", async () => {
    const r = await json(await app.send("POST", "/api/v1/incidents/INC-2/timeline", { text: "Looking at the report queue" }));
    expect(r.timeline.at(-1)).toMatchObject({ kind: "note", text: "Looking at the report queue", author: "admin token" });
    expect(
      (await json(await app.send("POST", "/api/v1/incidents/INC-2/timeline", { kind: "link", text: "https://logs.example.com/q/1" }))).timeline.at(-1).kind,
    ).toBe("link");
    for (const body of [{}, { text: "" }, { kind: "status-change", text: "I did it" }, { text: "x", at: "2020-01-01" }])
      expect(await status(app.send("POST", "/api/v1/incidents/INC-2/timeline", body)), JSON.stringify(body)).toBe(422);
  });

  it("tracks tasks, and writes a finished one to the timeline once", async () => {
    const t = await json(await app.send("POST", "/api/v1/incidents/INC-2/tasks", { title: "Restart the worker", owner: "Aylin", due: "2030-01-01T10:00:00Z" }));
    expect(t.openTasks).toBe(1);
    const task = t.tasks[0];
    expect(task).toMatchObject({ title: "Restart the worker", owner: "Aylin", done: false, due: "2030-01-01T10:00:00.000Z" });
    const done = await json(await app.send("PATCH", `/api/v1/incidents/INC-2/tasks/${task.id}`, { done: true }));
    expect(done).toMatchObject({ openTasks: 0, tasks: [{ done: true }] });
    expect(done.timeline.at(-1)).toMatchObject({ kind: "task-done", text: "Task done: Restart the worker" });
    const again = await json(await app.send("PATCH", `/api/v1/incidents/INC-2/tasks/${task.id}`, { done: true, owner: "Mert" }));
    expect(again.timeline.filter((e: { kind: string }) => e.kind === "task-done")).toHaveLength(1);
    expect(again.tasks[0].owner).toBe("Mert");
    expect(await status(app.send("PATCH", `/api/v1/incidents/INC-2/tasks/${task.id}`, { done: "yes" }))).toBe(422);
    expect(await status(app.send("PATCH", `/api/v1/incidents/INC-2/tasks/${task.id}`, {}))).toBe(422);
    expect(await status(app.send("PATCH", "/api/v1/incidents/INC-2/tasks/nope", { done: true }))).toBe(404);
    expect(await status(app.send("POST", "/api/v1/incidents/INC-2/tasks", { title: "" }))).toBe(422);
    expect(await status(app.send("POST", "/api/v1/incidents/INC-2/tasks", { title: "x", due: "someday" }))).toBe(422);
    expect(await status(app.send("DELETE", `/api/v1/incidents/INC-2/tasks/${task.id}`))).toBe(204);
    expect(await status(app.send("DELETE", `/api/v1/incidents/INC-2/tasks/${task.id}`))).toBe(404);
  });

  it("keeps links to evidence and never fetches or stores what they point at", async () => {
    const r = await json(
      await app.send("POST", "/api/v1/incidents/INC-2/evidence", { title: "Slow query log", url: "https://logs.example.com/q/7", source: "logs" }),
    );
    expect(r.evidence).toMatchObject([{ title: "Slow query log", url: "https://logs.example.com/q/7", source: "logs" }]);
    for (const body of [
      { title: "x", url: "javascript:alert(1)" },
      { title: "x", url: "https://u:p@example.com" },
      { title: "x", url: "nope" },
      { title: "", url: "https://a.example.com" },
      { title: "x", url: "https://a.example.com", source: "Bad Source" },
    ]) {
      expect(await status(app.send("POST", "/api/v1/incidents/INC-2/evidence", body)), JSON.stringify(body)).toBe(422);
    }
    expect(await status(app.send("DELETE", `/api/v1/incidents/INC-2/evidence/${r.evidence[0].id}`))).toBe(204);
    expect(await status(app.send("DELETE", `/api/v1/incidents/INC-2/evidence/${r.evidence[0].id}`))).toBe(404);
  });
});

describe("postmortem", () => {
  it("is written only once the incident is resolved, and published only with a body", async () => {
    expect(await status(app.send("PUT", "/api/v1/incidents/INC-2/postmortem", { body: "Notes", status: "draft" }))).toBe(409);
    const ok = await json(await app.send("PUT", "/api/v1/incidents/INC-1/postmortem", { body: "A bad deploy removed the cart index.", status: "draft" }));
    expect(ok.postmortem).toMatchObject({ body: "A bad deploy removed the cart index.", status: "draft", updatedBy: "admin token", publishedAt: null });
    expect(await status(app.send("PUT", "/api/v1/incidents/INC-1/postmortem", { body: "short", status: "published" }))).toBe(422);
    expect(await status(app.send("PUT", "/api/v1/incidents/INC-1/postmortem", { body: "x", status: "final" }))).toBe(422);
    const pub = await json(
      await app.send("PUT", "/api/v1/incidents/INC-1/postmortem", {
        body: "A bad deploy removed the cart index. We now test migrations.",
        status: "published",
      }),
    );
    expect(pub.postmortem.publishedAt).toEqual(expect.any(String));
    expect(pub.timeline.at(-1).text).toBe("Postmortem published.");
    // Editing a published one keeps when it was first published and writes no second entry.
    const edit = await json(
      await app.send("PUT", "/api/v1/incidents/INC-1/postmortem", {
        body: "A bad deploy removed the cart index. We now test migrations in CI.",
        status: "published",
      }),
    );
    expect(edit.postmortem.publishedAt).toBe(pub.postmortem.publishedAt);
    expect(edit.timeline.filter((t: { text: string }) => t.text === "Postmortem published.")).toHaveLength(1);
  });
});

describe("summary, deleting and access", () => {
  it("counts open incidents by severity, the mean time to resolve and postmortems owed", async () => {
    app.db
      .prepare("UPDATE incidents SET created_at = ?, resolved_at = ? WHERE number = 1")
      .run("2026-10-01T10:00:00.000Z", new Date(Date.now() - 86_400_000).toISOString());
    app.db.prepare("UPDATE incidents SET created_at = ? WHERE number = 1").run(new Date(Date.now() - 86_400_000 - 120 * 60_000).toISOString());
    const s = await json(await app.send("GET", "/api/v1/summary"));
    expect(s).toMatchObject({ total: 5, open: { critical: 0, high: 2, medium: 2, low: 0 }, resolved90d: 1, meanMinutesToResolve: 120, awaitingPostmortem: 0 });
    const metrics = await (await fetch(`${app.base}/metrics`)).text();
    expect(metrics).toContain('openasy_incidents_open{severity="high"} 2');
    expect(metrics).toContain("openasy_incidents_mean_minutes_to_resolve 120");
  });

  it("deletes an incident with everything on it", async () => {
    expect(await status(app.send("DELETE", "/api/v1/incidents/INC-5"))).toBe(204);
    expect(await status(app.send("GET", "/api/v1/incidents/INC-5"))).toBe(404);
    // Numbers are not reused for the next incident.
    expect((await open({ title: "Next incident" })).key).toBe("INC-5");
  });

  it("asks everyone to sign in or send an API token", async () => {
    for (const [m, p] of [
      ["GET", "/api/v1/incidents"],
      ["POST", "/api/v1/incidents"],
      ["GET", "/api/v1/incidents/INC-1"],
      ["PATCH", "/api/v1/incidents/INC-1"],
      ["DELETE", "/api/v1/incidents/INC-1"],
      ["GET", "/api/v1/summary"],
    ]) {
      expect((await fetch(app.base + p, { method: m })).status, `${m} ${p}`).toBe(401);
    }
    expect((await fetch(`${app.base}/api/v1/incidents`, { headers: { authorization: "Bearer nope" } })).status).toBe(401);
    expect(await json(await fetch(`${app.base}/api/v1/version`))).toEqual({ product: "incidents", version: "0.1.0" });
    expect((await fetch(`${app.base}/healthz`)).status).toBe(200);
    expect((await fetch(`${app.base}/readyz`)).status).toBe(200);
  });
});
