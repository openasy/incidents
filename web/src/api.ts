// The UI is an ordinary client of the public API (ADR 0014, 0018). Types follow openapi.json.

export type Severity = "critical" | "high" | "medium" | "low";
export type Status = "open" | "investigating" | "mitigated" | "resolved";
export type Counts = Record<Severity, number>;

/** Another OpenAsy product of this install, from OPENASY_PRODUCTS. */
export interface ProductLink {
  id: string;
  url: string;
}

export interface Summary {
  open: Counts;
  total: number;
  resolved90d: number;
  meanMinutesToResolve: number | null;
  awaitingPostmortem: number;
  /** The last 12 weeks, Monday to Sunday in UTC, oldest first. */
  weeks: Array<{ start: string; opened: number; resolved: number }>;
}

export interface TimelineEntry {
  id: number;
  kind: "note" | "status-change" | "severity-change" | "link" | "task-done";
  text: string;
  author: string;
  at: string;
}

export interface Task {
  id: string;
  title: string;
  owner: string | null;
  done: boolean;
  due: string | null;
  createdAt: string;
}

export interface Evidence {
  id: string;
  title: string;
  url: string;
  source: string | null;
  createdAt: string;
}

export interface Postmortem {
  body: string;
  status: "draft" | "published";
  updatedAt: string;
  updatedBy: string;
  publishedAt: string | null;
}

export interface IncidentSummary {
  id: string;
  key: string;
  number: number;
  title: string;
  severity: Severity;
  status: Status;
  commander: string | null;
  summary: string;
  products: string[];
  external: { source: string; reference: string } | null;
  openTasks: number;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
}

export interface Incident extends IncidentSummary {
  timeline: TimelineEntry[];
  tasks: Task[];
  evidence: Evidence[];
  postmortem: Postmortem | null;
}

export class Unauthorized extends Error {}
/** The signed-in owner or admin has no second factor yet; the sign-in gate asks for one. */
export class MfaSetupRequired extends Error {}
export class ApiError extends Error {}

// The session is an HttpOnly cookie set by sign-in (@openasy/auth); the browser sends it, nothing is stored here.
export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...init,
    credentials: "same-origin",
    headers: { ...(init.body ? { "content-type": "application/json" } : {}), ...init.headers },
  });
  if (!res.ok) {
    const problem = (await res.json().catch(() => ({}))) as { code?: string; detail?: string };
    if (res.status === 401) throw new Unauthorized(problem.detail);
    if (problem.code === "mfa-setup-required") throw new MfaSetupRequired(problem.detail);
    throw new ApiError(problem.detail ?? `${path}: ${res.status}`);
  }
  return (res.status === 204 ? undefined : await res.json()) as T;
}
