import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ADMIN_TOKEN, startApp } from "./test-app.ts";

// Contract tests (ADR 0024): every response the API sends must match openapi.json.

type Spec = {
  info: { version: string };
  paths: Record<string, Record<string, { responses: Record<string, { $ref?: string; content?: Record<string, { schema: object }> }> }>>;
  components: { responses: Record<string, { content: Record<string, { schema: object }> }> };
};

const spec = JSON.parse(readFileSync(new URL("../openapi.json", import.meta.url), "utf8")) as Spec;
const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };

const ajv = new Ajv2020({ strict: false, validateFormats: false });
ajv.addSchema(spec, "openapi");

const docsDir = mkdtempSync(join(tmpdir(), "incidents-docs-"));
writeFileSync(join(docsDir, "index.html"), "<!doctype html><title>API</title>");

let app: Awaited<ReturnType<typeof startApp>>;
let base: string;
const covered = new Set<string>();

beforeAll(async () => {
  app = await startApp({ version, openapi: spec, docsDir });
  base = app.base;
});

afterAll(() => app.close());

/** Calls the API and checks status, content type and body against the description. */
async function call(method: string, path: string, init: RequestInit = {}, concrete = path) {
  const res = await fetch(base + concrete, { ...init, method });
  const operation = spec.paths[path]?.[method.toLowerCase()];
  expect(operation, `${method} ${path} is not in openapi.json`).toBeDefined();
  covered.add(`${method} ${path}`);

  const declared = operation!.responses[String(res.status)];
  expect(declared, `${method} ${concrete} answered ${res.status}, which openapi.json does not list`).toBeDefined();
  // A response is either inline or a $ref to components/responses; build the JSON pointer to its schema either way.
  const shared = declared!.$ref?.split("/").pop();
  const response = shared ? spec.components.responses[shared]! : declared!;
  const at = shared
    ? `openapi#/components/responses/${shared}`
    : `openapi#/paths/${path.replaceAll("/", "~1")}/${method.toLowerCase()}/responses/${res.status}`;

  if (!response.content) {
    expect(res.headers.get("content-length") ?? "0", `${method} ${path} ${res.status} should have no body`).toBe("0");
    return { res, body: undefined };
  }
  const type = res.headers.get("content-type")!.split(";")[0]!;
  expect(response.content?.[type], `${method} ${path} ${res.status} sent ${type}, which openapi.json does not list`).toBeDefined();

  const body = type.endsWith("json") ? await res.json() : await res.text();
  const schema = `${at}/content/${type.replace("/", "~1")}/schema`;
  const validate = ajv.getSchema(schema)!;
  expect(validate(body), JSON.stringify(validate.errors)).toBe(true);
  return { res, body };
}

const auth = (token: string, body?: string, type = "application/json") => ({
  headers: { authorization: `Bearer ${token}`, "content-type": type },
  ...(body !== undefined && { body }),
});
const admin = (body?: unknown) => auth(ADMIN_TOKEN, body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body));

describe("openapi.json", () => {
  it("has the version of this release", () => {
    expect(spec.info.version).toBe(version);
  });

  it("is served with the running version", async () => {
    const served = (await (await fetch(`${base}/api/openapi.json`)).json()) as Spec;
    expect(served.info.version).toBe(version);
    // incidents's own operations, then sign-in from @openasy/auth (tested against its description in that package).
    expect(Object.keys(served.paths).filter((p) => !p.startsWith("/api/v1/auth/"))).toEqual(Object.keys(spec.paths));
    expect(served.paths["/api/v1/auth/login"]).toBeDefined();
  });

  it("serves the API reference at /api/docs/", async () => {
    expect((await fetch(`${base}/api/docs`, { redirect: "manual" })).headers.get("location")).toBe("/api/docs/");
    const res = await fetch(`${base}/api/docs/`);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect((await fetch(`${base}/api/docs/../../package.json`)).status).not.toBe(200);
  });
});

describe("responses match openapi.json", () => {
  const inc = (id: string) => `/api/v1/incidents/${id}`;
  let key = "";
  let task = "";
  let evidence = "";

  it("product and health", async () => {
    await call("GET", "/api/v1/version");
    await call("GET", "/api/v1/products", admin());
    await call("GET", "/api/v1/products", {});
    await call("GET", "/healthz");
    await call("GET", "/readyz");
    await call("GET", "/metrics");
  });

  it("opening and listing", async () => {
    const created = (
      await call(
        "POST",
        "/api/v1/incidents",
        admin({ title: "Checkout is down", severity: "critical", commander: "Aylin", products: ["logs"], external: { source: "siem", reference: "sig-1" } }),
      )
    ).body as { id: string; key: string };
    key = created.key;
    await call("POST", "/api/v1/incidents", admin({ title: "Checkout is down", external: { source: "siem", reference: "sig-1" } }));
    await call("POST", "/api/v1/incidents", admin({ title: "x" }));
    await call("POST", "/api/v1/incidents", admin("nope"));
    await call("POST", "/api/v1/incidents", {});
    await call("GET", "/api/v1/incidents", admin());
    await call("GET", "/api/v1/incidents", admin(), "/api/v1/incidents?status=active&severity=critical&product=logs&q=checkout&limit=1");
    await call("GET", "/api/v1/incidents", admin(), "/api/v1/incidents?status=gone");
    await call("GET", "/api/v1/incidents", {});
    await call("GET", "/api/v1/incidents/{id}", admin(), inc(key));
    await call("GET", "/api/v1/incidents/{id}", admin(), inc(created.id));
    await call("GET", "/api/v1/incidents/{id}", admin(), inc("INC-99"));
    await call("GET", "/api/v1/incidents/{id}", {}, inc(key));
  });

  it("changing, the timeline, tasks and evidence", async () => {
    await call("PATCH", "/api/v1/incidents/{id}", admin({ status: "investigating", severity: "high" }), inc(key));
    await call("PATCH", "/api/v1/incidents/{id}", admin({}), inc(key));
    await call("PATCH", "/api/v1/incidents/{id}", admin({ status: "open" }), inc("INC-99"));
    await call("PATCH", "/api/v1/incidents/{id}", { method: "PATCH" }, inc(key));
    await call("POST", "/api/v1/incidents/{id}/timeline", admin({ text: "Looking at the logs" }), `${inc(key)}/timeline`);
    await call("POST", "/api/v1/incidents/{id}/timeline", admin({ text: "" }), `${inc(key)}/timeline`);
    await call("POST", "/api/v1/incidents/{id}/timeline", admin({ text: "x" }), `${inc("INC-99")}/timeline`);
    await call("POST", "/api/v1/incidents/{id}/timeline", { method: "POST" }, `${inc(key)}/timeline`);

    const withTask = (
      await call("POST", "/api/v1/incidents/{id}/tasks", admin({ title: "Roll back", owner: "Mert", due: "2030-01-01T00:00:00Z" }), `${inc(key)}/tasks`)
    ).body as { tasks: Array<{ id: string }> };
    task = withTask.tasks[0]!.id;
    await call("POST", "/api/v1/incidents/{id}/tasks", admin({}), `${inc(key)}/tasks`);
    await call("POST", "/api/v1/incidents/{id}/tasks", { method: "POST" }, `${inc(key)}/tasks`);
    await call("PATCH", "/api/v1/incidents/{id}/tasks/{taskId}", admin({ done: true }), `${inc(key)}/tasks/${task}`);
    await call("PATCH", "/api/v1/incidents/{id}/tasks/{taskId}", admin({ done: "yes" }), `${inc(key)}/tasks/${task}`);
    await call("PATCH", "/api/v1/incidents/{id}/tasks/{taskId}", admin({ done: true }), `${inc(key)}/tasks/missing`);
    await call("PATCH", "/api/v1/incidents/{id}/tasks/{taskId}", { method: "PATCH" }, `${inc(key)}/tasks/${task}`);

    const withEvidence = (
      await call(
        "POST",
        "/api/v1/incidents/{id}/evidence",
        admin({ title: "Error rate", url: "https://logs.example.com/q/1", source: "logs" }),
        `${inc(key)}/evidence`,
      )
    ).body as { evidence: Array<{ id: string }> };
    evidence = withEvidence.evidence[0]!.id;
    await call("POST", "/api/v1/incidents/{id}/evidence", admin({ title: "Bad", url: "javascript:alert(1)" }), `${inc(key)}/evidence`);
    await call("POST", "/api/v1/incidents/{id}/evidence", { method: "POST" }, `${inc(key)}/evidence`);

    await call("DELETE", "/api/v1/incidents/{id}/tasks/{taskId}", admin(), `${inc(key)}/tasks/${task}`);
    await call("DELETE", "/api/v1/incidents/{id}/tasks/{taskId}", admin(), `${inc(key)}/tasks/${task}`);
    await call("DELETE", "/api/v1/incidents/{id}/tasks/{taskId}", { method: "DELETE" }, `${inc(key)}/tasks/x`);
    await call("DELETE", "/api/v1/incidents/{id}/evidence/{evidenceId}", admin(), `${inc(key)}/evidence/${evidence}`);
    await call("DELETE", "/api/v1/incidents/{id}/evidence/{evidenceId}", admin(), `${inc(key)}/evidence/${evidence}`);
    await call("DELETE", "/api/v1/incidents/{id}/evidence/{evidenceId}", { method: "DELETE" }, `${inc(key)}/evidence/x`);
  });

  it("postmortem, summary and deleting", async () => {
    await call("PUT", "/api/v1/incidents/{id}/postmortem", admin({ body: "Notes", status: "draft" }), `${inc(key)}/postmortem`);
    await call("PATCH", "/api/v1/incidents/{id}", admin({ status: "resolved" }), inc(key));
    await call("PUT", "/api/v1/incidents/{id}/postmortem", admin({ body: "A bad deploy removed the index.", status: "published" }), `${inc(key)}/postmortem`);
    await call("PUT", "/api/v1/incidents/{id}/postmortem", admin({ body: "short", status: "published" }), `${inc(key)}/postmortem`);
    await call("PUT", "/api/v1/incidents/{id}/postmortem", admin({ body: "x" }), `${inc("INC-99")}/postmortem`);
    await call("PUT", "/api/v1/incidents/{id}/postmortem", { method: "PUT" }, `${inc(key)}/postmortem`);
    await call("GET", "/api/v1/summary", admin());
    await call("GET", "/api/v1/summary", {});
    await call("DELETE", "/api/v1/incidents/{id}", admin(), inc(key));
    await call("DELETE", "/api/v1/incidents/{id}", admin(), inc(key));
    await call("DELETE", "/api/v1/incidents/{id}", { method: "DELETE" }, inc("INC-1"));
  });

  it("covers every operation in openapi.json", () => {
    const all = Object.entries(spec.paths).flatMap(([path, ops]) => Object.keys(ops).map((m) => `${m.toUpperCase()} ${path}`));
    expect([...covered].sort()).toEqual(all.sort());
  });
});
