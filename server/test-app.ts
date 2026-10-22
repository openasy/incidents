// Starts the app on a random port for tests.
import { createServer, type RequestListener, type Server } from "node:http";
import { createAuth } from "@openasy/auth";
import type { AddressInfo } from "node:net";
import { createApp, type AppOptions } from "./app.ts";
import { openDb } from "./db.ts";
import { createIncidents } from "./incidents.ts";

export const ADMIN_TOKEN = "test-admin-token";

export async function startApp(opts: Partial<AppOptions> & { version: string }) {
  const db = openDb(":memory:");
  const incidents = createIncidents(db);
  // The origin is known once the port is, so the handler is set after listening.
  let handler: RequestListener = (_req, res) => res.writeHead(503).end();
  const server: Server = createServer((req, res) => handler(req, res));
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  const auth = createAuth({ db, product: "incidents", productName: "OpenAsy Incidents", origin: base });
  handler = createApp({ db, incidents, auth, adminToken: ADMIN_TOKEN, ...opts });
  const admin = (path: string, init: RequestInit = {}) => fetch(base + path, { ...init, headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json", ...init.headers } });
  const send = (method: string, path: string, body?: unknown) => admin(path, { method, ...(body !== undefined && { body: JSON.stringify(body) }) });
  const close = () => new Promise<void>((resolve) => server.close(() => resolve()));
  return { db, incidents, auth, base, admin, send, close };
}
