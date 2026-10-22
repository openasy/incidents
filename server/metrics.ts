// Prometheus text exposition, written by hand: a few lines, no client library needed.
const requests = new Map<string, number>();

export function countRequest(method: string, route: string, status: number) {
  const key = `method="${method}",route="${route}",status="${status}"`;
  requests.set(key, (requests.get(key) ?? 0) + 1);
}

export interface Gauges {
  /** Incidents that are not resolved, by severity. */
  open: Record<string, number>;
  total: number;
  /** Mean minutes from opening to resolving, over the last 90 days; null without a resolved incident. */
  meanMinutesToResolve: number | null;
  awaitingPostmortem: number;
}

export function renderMetrics(version: string, g: Gauges): string {
  const lines = [
    "# HELP openasy_build_info Build information.",
    "# TYPE openasy_build_info gauge",
    `openasy_build_info{product="incidents",version="${version}"} 1`,
    "# HELP openasy_http_requests_total HTTP requests handled.",
    "# TYPE openasy_http_requests_total counter",
    ...[...requests].map(([labels, n]) => `openasy_http_requests_total{${labels}} ${n}`),
    "# HELP openasy_incidents_open Incidents that are not resolved, by severity.",
    "# TYPE openasy_incidents_open gauge",
    ...Object.entries(g.open).map(([s, n]) => `openasy_incidents_open{severity="${s}"} ${n}`),
    "# HELP openasy_incidents_total Incidents kept.",
    "# TYPE openasy_incidents_total gauge",
    `openasy_incidents_total ${g.total}`,
    "# HELP openasy_incidents_mean_minutes_to_resolve Mean minutes from opening to resolving, last 90 days; absent without a resolved incident.",
    "# TYPE openasy_incidents_mean_minutes_to_resolve gauge",
    ...(g.meanMinutesToResolve === null ? [] : [`openasy_incidents_mean_minutes_to_resolve ${g.meanMinutesToResolve}`]),
    "# HELP openasy_incidents_awaiting_postmortem Resolved incidents without a published postmortem.",
    "# TYPE openasy_incidents_awaiting_postmortem gauge",
    `openasy_incidents_awaiting_postmortem ${g.awaitingPostmortem}`,
    "# HELP process_uptime_seconds Seconds since the process started.",
    "# TYPE process_uptime_seconds gauge",
    `process_uptime_seconds ${process.uptime().toFixed(0)}`,
  ];
  return lines.join("\n") + "\n";
}
