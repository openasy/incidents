// What the search window (Cmd+K) finds in Incidents: incidents by key, title, summary or commander, from the API.
import type { SearchFn, SearchResult } from "@openasy/ui";
import { Siren } from "lucide-react";
import type { IncidentSummary } from "./api.ts";
import type { T } from "./i18n.ts";

type Call = <R>(path: string, init?: RequestInit) => Promise<R>;
const query = (q: string) => new URLSearchParams({ q, limit: "8" });

export function search(call: Call, t: T): SearchFn {
  return async (q, signal) => {
    const found = await call<{ incidents: IncidentSummary[] }>(`/api/v1/incidents?${query(q)}`, { signal });
    return found.incidents.map((i): SearchResult => ({
      id: `incident:${i.id}`,
      label: `${i.key} ${i.title}`,
      detail: t("search.incidentDetail", { status: i.status, commander: i.commander ?? t("search.noCommander") }),
      kind: t("search.incident"),
      icon: Siren,
      severity: i.severity,
      href: `/incidents/${encodeURIComponent(i.key)}`,
    }));
  };
}
