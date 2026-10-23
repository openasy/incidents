import {
  AppShell,
  Badge,
  BrandProvider,
  Button,
  Checkbox,
  DataTable,
  Dialog,
  EmptyState,
  FacetFilter,
  FilterBar,
  IconButton,
  KpiCard,
  KpiGrid,
  navigate,
  PageHeader,
  Panel,
  PRODUCT_IDS,
  SearchInput,
  SelectField,
  SeverityBadge,
  StatusBadge,
  Tabs,
  TextField,
  usePath,
  type Column,
  type ProductId,
  useThemePreference,
  useAgo,
} from "@openasy/ui";
import { AccountSettings, AuthGate, MembersSettings, SignInSettings, TokensSettings, useAuth } from "@openasy/auth/react";
import { KeyRound, LogIn, LogOut, Plus, Settings2, Siren, Trash2, UserRound, Users } from "lucide-react";
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { api, MfaSetupRequired, Unauthorized, type Incident, type IncidentSummary, type ProductLink, type Severity, type Status, type Summary } from "./api.ts";
import { useT, type T } from "./i18n.ts";

/** 95 minutes is "1 h 35 min"; the clock of an incident is read in hours more than in seconds. */
function duration(minutes: number | null): string {
  if (minutes === null) return "–";
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  return h >= 48 ? `${Math.round(h / 24)} d` : `${h} h ${minutes % 60} min`;
}

const PAGES = ["setup", "account", "members", "signin", "tokens"] as const;
type Route = { page: "incidents" | (typeof PAGES)[number] } | { page: "incident"; id: string };
/** The first path segments that are pages of this UI, for followLinks. */
export const PATHS = ["incidents", ...PAGES];
function parseRoute(path: string): Route {
  const [page, id] = path.replace(/^\//, "").split("/");
  if (page === "incidents" && id) return { page: "incident", id: decodeURIComponent(id) };
  if ((PAGES as readonly string[]).includes(page ?? "")) return { page: page as (typeof PAGES)[number] };
  return { page: "incidents" };
}

/** Data loading with the session; when it ends, the sign-in screen comes back. */
function useApi() {
  const { expired, refresh } = useAuth();
  return useCallback(
    async <T,>(path: string, init?: RequestInit): Promise<T> => {
      try {
        return await api<T>(path, init);
      } catch (err) {
        if (err instanceof Unauthorized) expired();
        if (err instanceof MfaSetupRequired) void refresh();
        throw err;
      }
    },
    [expired, refresh],
  );
}
type Call = ReturnType<typeof useApi>;

const SEVERITIES: Severity[] = ["critical", "high", "medium", "low"];
const STATUSES = (t: T): Array<{ value: Status; label: string }> => [
  { value: "open", label: t("statuses.open") },
  { value: "investigating", label: t("statuses.investigating") },
  { value: "mitigated", label: t("statuses.mitigated") },
  { value: "resolved", label: t("statuses.resolved") },
];
const sevOptions = SEVERITIES.map((s) => ({ value: s, label: s.charAt(0).toUpperCase() + s.slice(1) }));

function StatusPill({ status }: { status: Status }) {
  const t = useT();
  const tone = status === "resolved" ? "success" : status === "mitigated" ? "info" : status === "investigating" ? "warning" : "danger";
  return <StatusBadge tone={tone}>{STATUSES(t).find((s) => s.value === status)!.label}</StatusBadge>;
}

function Products({ ids }: { ids: string[] }) {
  const t = useT();
  if (!ids.length) return <span className="text-xs text-fg-muted">{t("products.noneNamed")}</span>;
  return (
    <span className="flex flex-wrap gap-1">
      {ids.map((p) => (
        <Badge key={p} mono>
          {p}
        </Badge>
      ))}
    </span>
  );
}

// ---------------------------------------------------------------- Incidents list

type View = "active" | "resolved" | "all";

function NewIncidentDialog({ open, onClose, call, onCreated }: { open: boolean; onClose: () => void; call: Call; onCreated: (key: string) => void }) {
  const t = useT();
  const { me } = useAuth();
  const [title, setTitle] = useState("");
  const [severity, setSeverity] = useState<Severity>("medium");
  const [commander, setCommander] = useState(me.user.name);
  const [products, setProducts] = useState("");
  const [summary, setSummary] = useState("");
  const [error, setError] = useState<string>();
  const close = () => (setTitle(""), setSeverity("medium"), setProducts(""), setSummary(""), setError(undefined), onClose());

  const create = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const list = products.split(/[\s,]+/).filter(Boolean);
      const i = await call<Incident>("/api/v1/incidents", {
        method: "POST",
        body: JSON.stringify({ title, severity, commander: commander || undefined, summary: summary || undefined, products: list }),
      });
      close();
      onCreated(i.key);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && close()}
      title={t("newIncidentDialog.openAnIncident")}
      description={t("newIncidentDialog.sayWhatIsWrongHow")}
      onSubmit={create}
      footer={
        <>
          <Button type="button" onClick={close}>
            {t("newIncidentDialog.cancel")}
          </Button>
          <Button type="submit" variant="primary" icon={<Siren />} disabled={title.trim().length < 3}>
            {t("newIncidentDialog.openIncident")}
          </Button>
        </>
      }
    >
      <TextField label={t("newIncidentDialog.title")} value={title} onChange={(e) => setTitle(e.target.value)} error={error} />
      <div className="grid grid-cols-2 gap-2">
        <SelectField label={t("newIncidentDialog.severity")} value={severity} onChange={(e) => setSeverity(e.target.value as Severity)} options={sevOptions} />
        <TextField label={t("newIncidentDialog.commander")} value={commander} onChange={(e) => setCommander(e.target.value)} />
      </div>
      <TextField
        label={t("newIncidentDialog.productsInvolved")}
        value={products}
        onChange={(e) => setProducts(e.target.value)}
        hint={t("newIncidentDialog.productIdsSeparatedByCommas")}
      />
      <TextField label={t("newIncidentDialog.summary")} value={summary} onChange={(e) => setSummary(e.target.value)} />
    </Dialog>
  );
}

function IncidentsPage({ call, summary, reload }: { call: Call; summary?: Summary; reload: () => void }) {
  const ago = useAgo();
  const t = useT();
  const { can } = useAuth();
  const [view, setView] = useState<View>("active");
  const [sev, setSev] = useState<string[]>([]);
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<IncidentSummary[]>();
  const [more, setMore] = useState<string>();
  const [adding, setAdding] = useState(false);

  const query = useCallback(
    (cursor?: string) => {
      const p = new URLSearchParams({ limit: "200" });
      if (view !== "all") p.set("status", view);
      if (sev.length) p.set("severity", sev.join(","));
      if (q.trim()) p.set("q", q.trim());
      if (cursor) p.set("cursor", cursor);
      return call<{ incidents: IncidentSummary[]; nextCursor?: string }>(`/api/v1/incidents?${p}`);
    },
    [call, view, sev, q],
  );
  const load = useCallback(
    () =>
      void query().then(
        (r) => (setRows(r.incidents), setMore(r.nextCursor)),
        () => setRows([]),
      ),
    [query],
  );
  useEffect(load, [load]);
  const loadMore = () => more && query(more).then((r) => (setRows((x) => [...(x ?? []), ...r.incidents]), setMore(r.nextCursor)));

  const columns: Column<IncidentSummary>[] = [
    { id: "sev", header: t("incidentsPage.severity"), width: "104px", cell: (i) => <SeverityBadge severity={i.severity} /> },
    {
      id: "title",
      header: t("incidentsPage.incident"),
      width: "36%",
      sortValue: (i) => i.number,
      cell: (i) => (
        <span className="flex min-w-0 flex-col">
          <a href={`/incidents/${i.key}`} className="incidents-wrap font-medium">
            <span className="font-mono text-xs text-fg-muted">{i.key}</span> {i.title}
          </a>
          {i.summary && (
            <span className="incidents-clamp text-xs text-fg-muted" title={i.summary}>
              {i.summary}
            </span>
          )}
        </span>
      ),
    },
    { id: "status", header: t("incidentsPage.status"), cell: (i) => <StatusPill status={i.status} /> },
    { id: "commander", header: t("incidentsPage.commander"), cell: (i) => <span className="text-xs">{i.commander ?? "–"}</span> },
    { id: "products", header: t("incidentsPage.products"), cell: (i) => <Products ids={i.products} /> },
    { id: "tasks", header: t("incidentsPage.openTasks"), align: "right", cell: (i) => i.openTasks },
    {
      id: "opened",
      header: t("incidentsPage.opened"),
      sortValue: (i) => i.createdAt,
      cell: (i) => <span className="text-xs whitespace-nowrap">{ago(i.createdAt)}</span>,
    },
  ];

  const s = summary;
  const openTotal = s ? Object.values(s.open).reduce((a, b) => a + b, 0) : 0;
  return (
    <>
      <PageHeader
        title={t("incidentsPage.incidents")}
        description={s ? t("incidentsPage.openKept", { openTotal, total: s.total }) : undefined}
        actions={
          <>
            <SearchInput label={t("incidentsPage.searchIncidents")} className="w-64" value={q} onChange={(e) => setQ(e.target.value)} />
            {can("editor") && (
              <Button variant="primary" icon={<Plus />} onClick={() => setAdding(true)}>
                {t("incidentsPage.openIncident")}
              </Button>
            )}
          </>
        }
      />
      {s && (
        <KpiGrid minWidth={150}>
          <KpiCard
            label={t("incidentsPage.critical")}
            value={s.open.critical}
            tone={s.open.critical ? "danger" : "success"}
            footer={<SeverityBadge severity="critical" />}
          />
          <KpiCard label={t("incidentsPage.high")} value={s.open.high} footer={<SeverityBadge severity="high" />} />
          <KpiCard label={t("incidentsPage.medium")} value={s.open.medium} footer={<SeverityBadge severity="medium" />} />
          <KpiCard label={t("incidentsPage.low")} value={s.open.low} footer={<SeverityBadge severity="low" />} />
          <KpiCard label={t("incidentsPage.meanTimeToResolve90")} value={duration(s.meanMinutesToResolve)} tone="info" />
          <KpiCard label={t("incidentsPage.waitingForAPostmortem")} value={s.awaitingPostmortem} tone={s.awaitingPostmortem ? "warning" : "success"} />
        </KpiGrid>
      )}
      <Tabs<View>
        label={t("incidentsPage.incidentViews")}
        value={view}
        onChange={setView}
        items={[
          { value: "active", label: t("incidentsPage.active") },
          { value: "resolved", label: t("incidentsPage.resolved") },
          { value: "all", label: t("incidentsPage.all") },
        ]}
      />
      <FilterBar onClear={() => (setSev([]), setQ(""))}>
        <FacetFilter
          label={t("incidentsPage.severity")}
          selected={sev}
          onChange={setSev}
          options={sevOptions.map((o) => ({ ...o, count: view === "active" ? s?.open[o.value as Severity] : undefined }))}
        />
      </FilterBar>
      <Panel
        flush
        footer={
          more ? (
            <Button size="sm" onClick={loadMore}>
              {t("incidentsPage.loadMore")}
            </Button>
          ) : undefined
        }
      >
        <DataTable
          label={t("incidentsPage.incidents")}
          columns={columns}
          rows={rows ?? []}
          loading={!rows}
          getRowId={(i) => i.id}
          minWidth={980}
          pageSize={50}
          empty={
            <EmptyState title={view === "active" ? t("incidentsPage.noActiveIncidents") : t("incidentsPage.noIncidents")}>
              {s && s.total === 0 ? (
                <>
                  {t("incidentsPage.nothingHasBeenOpenedYet")} <a href="/setup">{t("incidentsPage.setup")}</a>.
                </>
              ) : (
                t("incidentsPage.nothingMatchesTheseFilters")
              )}
            </EmptyState>
          }
        />
      </Panel>
      <NewIncidentDialog
        open={adding}
        onClose={() => setAdding(false)}
        call={call}
        onCreated={(key) => {
          reload();
          navigate(`/incidents/${key}`);
        }}
      />
    </>
  );
}

// ---------------------------------------------------------------- One incident

type Section = "timeline" | "tasks" | "evidence" | "postmortem";

const KIND_LABEL = (t: T): Record<string, string> => ({
  note: "Note",
  "status-change": "Status",
  "severity-change": "Severity",
  link: "Link",
  "task-done": t("kindLabel.taskDone"),
});

function TimelinePanel({ incident, call, onChange }: { incident: Incident; call: Call; onChange: (i: Incident) => void }) {
  const ago = useAgo();
  const msg = useT();
  const { can } = useAuth();
  const [text, setText] = useState("");
  const [error, setError] = useState<string>();
  const add = async (e: FormEvent) => {
    e.preventDefault();
    try {
      onChange(await call<Incident>(`/api/v1/incidents/${incident.id}/timeline`, { method: "POST", body: JSON.stringify({ text }) }));
      setText("");
      setError(undefined);
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <Panel title={msg("timelinePanel.timeline")} description={msg("timelinePanel.whatHappenedInOrderNothing")}>
      <ul className="incidents-list flex flex-col gap-2.5">
        {incident.timeline.map((t) => (
          <li key={t.id} className="flex gap-2.5 text-sm">
            <span className="w-28 shrink-0 text-xs whitespace-nowrap text-fg-muted" title={new Date(t.at).toLocaleString()}>
              {ago(t.at)}
            </span>
            <span className="flex min-w-0 flex-col">
              <span className="incidents-wrap">
                <Badge>{KIND_LABEL(msg)[t.kind]}</Badge> {t.text}
              </span>
              <span className="text-xs text-fg-muted">{t.author}</span>
            </span>
          </li>
        ))}
      </ul>
      {can("editor") && (
        <form onSubmit={add} className="mt-3 flex items-end gap-2 border-t border-line pt-3">
          <TextField className="flex-1" label={msg("timelinePanel.addANote")} value={text} onChange={(e) => setText(e.target.value)} error={error} />
          <Button type="submit" variant="primary" disabled={!text.trim()}>
            {msg("timelinePanel.add")}
          </Button>
        </form>
      )}
    </Panel>
  );
}

function TasksPanel({ incident, call, onChange }: { incident: Incident; call: Call; onChange: (i: Incident) => void }) {
  const msg = useT();
  const { can } = useAuth();
  const [title, setTitle] = useState("");
  const [owner, setOwner] = useState("");
  const [error, setError] = useState<string>();
  const base = `/api/v1/incidents/${incident.id}/tasks`;
  const add = async (e: FormEvent) => {
    e.preventDefault();
    try {
      onChange(await call<Incident>(base, { method: "POST", body: JSON.stringify({ title, owner: owner || undefined }) }));
      setTitle("");
      setOwner("");
      setError(undefined);
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <Panel title={msg("tasksPanel.tasks")} description={msg("tasksPanel.whatHasToBeDone")}>
      {incident.tasks.length === 0 ? (
        <p className="m-0 text-sm text-fg-muted">{msg("tasksPanel.noTasksYet")}</p>
      ) : (
        <ul className="incidents-list flex flex-col gap-2">
          {incident.tasks.map((t) => (
            <li key={t.id} className="flex items-center gap-2 text-sm">
              <Checkbox
                label={<span className={t.done ? "text-fg-muted line-through" : ""}>{t.title}</span>}
                checked={t.done}
                disabled={!can("editor")}
                onChange={(e) =>
                  void call<Incident>(`${base}/${t.id}`, { method: "PATCH", body: JSON.stringify({ done: e.target.checked }) }).then(onChange, () => {})
                }
              />
              {t.owner && <Badge>{t.owner}</Badge>}
              {t.due && <span className="text-xs text-fg-muted">due {new Date(t.due).toLocaleDateString()}</span>}
              {can("editor") && (
                <IconButton
                  label={msg("tasksPanel.deleteTheTask", { title: t.title })}
                  size="sm"
                  onClick={() =>
                    void call(`${base}/${t.id}`, { method: "DELETE" }).then(
                      () => call<Incident>(`/api/v1/incidents/${incident.id}`).then(onChange),
                      () => {},
                    )
                  }
                >
                  <Trash2 />
                </IconButton>
              )}
            </li>
          ))}
        </ul>
      )}
      {can("editor") && (
        <form onSubmit={add} className="mt-3 flex items-end gap-2 border-t border-line pt-3">
          <TextField className="flex-1" label={msg("tasksPanel.newTask")} value={title} onChange={(e) => setTitle(e.target.value)} error={error} />
          <TextField className="w-40" label={msg("tasksPanel.owner")} value={owner} onChange={(e) => setOwner(e.target.value)} />
          <Button type="submit" variant="primary" disabled={!title.trim()}>
            {msg("tasksPanel.add")}
          </Button>
        </form>
      )}
    </Panel>
  );
}

function EvidencePanel({ incident, call, onChange }: { incident: Incident; call: Call; onChange: (i: Incident) => void }) {
  const t = useT();
  const { can } = useAuth();
  const [title, setTitle] = useState("");
  const [url, setUrl] = useState("");
  const [source, setSource] = useState("");
  const [error, setError] = useState<string>();
  const base = `/api/v1/incidents/${incident.id}/evidence`;
  const add = async (e: FormEvent) => {
    e.preventDefault();
    try {
      onChange(await call<Incident>(base, { method: "POST", body: JSON.stringify({ title, url, source: source || undefined }) }));
      setTitle("");
      setUrl("");
      setSource("");
      setError(undefined);
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <Panel title={t("evidencePanel.evidence")} description={t("evidencePanel.linksToWhereTheEvidence")}>
      {incident.evidence.length === 0 ? (
        <p className="m-0 text-sm text-fg-muted">{t("evidencePanel.noEvidenceLinkedYet")}</p>
      ) : (
        <ul className="incidents-list flex flex-col gap-2">
          {incident.evidence.map((ev) => (
            <li key={ev.id} className="flex items-center gap-2 text-sm">
              <a href={ev.url} target="_blank" rel="noreferrer noopener" className="incidents-wrap">
                {ev.title}
              </a>
              {ev.source && <Badge mono>{ev.source}</Badge>}
              {can("editor") && (
                <IconButton
                  label={t("evidencePanel.removeTheLink", { title: ev.title })}
                  size="sm"
                  onClick={() =>
                    void call(`${base}/${ev.id}`, { method: "DELETE" }).then(
                      () => call<Incident>(`/api/v1/incidents/${incident.id}`).then(onChange),
                      () => {},
                    )
                  }
                >
                  <Trash2 />
                </IconButton>
              )}
            </li>
          ))}
        </ul>
      )}
      {can("editor") && (
        <form onSubmit={add} className="mt-3 flex flex-wrap items-end gap-2 border-t border-line pt-3">
          <TextField className="w-48" label={t("evidencePanel.title")} value={title} onChange={(e) => setTitle(e.target.value)} />
          <TextField className="min-w-64 flex-1" label={t("evidencePanel.address")} value={url} onChange={(e) => setUrl(e.target.value)} error={error} />
          <TextField
            className="w-32"
            label={t("evidencePanel.product")}
            value={source}
            onChange={(e) => setSource(e.target.value)}
            hint={t("evidencePanel.suchAsLogs")}
          />
          <Button type="submit" variant="primary" disabled={!title.trim() || !url.trim()}>
            {t("evidencePanel.add")}
          </Button>
        </form>
      )}
    </Panel>
  );
}

function PostmortemPanel({ incident, call, onChange }: { incident: Incident; call: Call; onChange: (i: Incident) => void }) {
  const ago = useAgo();
  const t = useT();
  const { can } = useAuth();
  const [body, setBody] = useState(incident.postmortem?.body ?? "");
  const [error, setError] = useState<string>();
  const pm = incident.postmortem;
  const save = async (status: "draft" | "published") => {
    try {
      onChange(await call<Incident>(`/api/v1/incidents/${incident.id}/postmortem`, { method: "PUT", body: JSON.stringify({ body, status }) }));
      setError(undefined);
    } catch (err) {
      setError((err as Error).message);
    }
  };
  if (incident.status !== "resolved") {
    return (
      <Panel title={t("postmortemPanel.postmortem")}>
        <EmptyState title={t("postmortemPanel.notYet")}>{t("postmortemPanel.aPostmortemIsWrittenOnce")}</EmptyState>
      </Panel>
    );
  }
  return (
    <Panel
      title={t("postmortemPanel.postmortem")}
      description={t("postmortemPanel.whatHappenedWhyAndWhat")}
      actions={
        pm ? (
          <StatusBadge tone={pm.status === "published" ? "success" : "warning"}>
            {pm.status === "published" ? t("postmortemPanel.published") : t("postmortemPanel.draft")}
          </StatusBadge>
        ) : (
          <StatusBadge tone="danger">{t("postmortemPanel.notWritten")}</StatusBadge>
        )
      }
    >
      {can("editor") ? (
        <div className="flex flex-col gap-2">
          <textarea
            aria-label={t("postmortemPanel.postmortem")}
            className="incidents-textarea w-full rounded-md border border-line-strong bg-surface px-2.5 py-2 text-sm text-fg"
            value={body}
            onChange={(e) => setBody(e.target.value)}
          />
          {error && <span className="text-xs text-danger-text">{error}</span>}
          <div className="flex items-center gap-2">
            <Button onClick={() => void save("draft")}>{t("postmortemPanel.saveDraft")}</Button>
            <Button variant="primary" onClick={() => void save("published")} disabled={body.trim().length < 10}>
              {t("postmortemPanel.publish")}
            </Button>
            {pm && (
              <span className="text-xs text-fg-muted">
                {pm.updatedBy}, {ago(pm.updatedAt)}
              </span>
            )}
          </div>
        </div>
      ) : pm ? (
        <div className="incidents-prose text-sm">{pm.body}</div>
      ) : (
        <p className="m-0 text-sm text-fg-muted">{t("postmortemPanel.nothingHasBeenWrittenYet")}</p>
      )}
    </Panel>
  );
}

function IncidentPage({ call, id, reload }: { call: Call; id: string; reload: () => void }) {
  const ago = useAgo();
  const t = useT();
  const { can } = useAuth();
  const [incident, setIncident] = useState<Incident | null>();
  const [section, setSection] = useState<Section>("timeline");
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => void call<Incident>(`/api/v1/incidents/${encodeURIComponent(id)}`).then(setIncident, () => setIncident(null)), [call, id]);

  if (incident === null)
    return (
      <EmptyState title={t("incidentPage.incidentNotFound")}>
        {t("incidentPage.itMayHaveBeenDeleted")} <a href="/incidents">{t("incidentPage.backToIncidents")}</a>.
      </EmptyState>
    );
  const changed = (i: Incident) => (setIncident(i), reload());
  const patch = (body: Record<string, unknown>) =>
    call<Incident>(`/api/v1/incidents/${id}`, { method: "PATCH", body: JSON.stringify(body) }).then(changed, (err: Error) => setError(err.message));
  const remove = () =>
    call(`/api/v1/incidents/${id}`, { method: "DELETE" }).then(
      () => {
        reload();
        navigate("/incidents");
      },
      (err: Error) => setError(err.message),
    );

  return (
    <>
      <PageHeader
        title={incident ? `${incident.key} ${incident.title}` : t("incidentPage.incident")}
        description={
          incident
            ? t("incidentPage.opened", {
                ago: ago(incident.createdAt),
                value: incident.resolvedAt ? `, resolved ${ago(incident.resolvedAt)}` : "",
                value2: incident.external ? ` · reported by ${incident.external.source}` : "",
              })
            : undefined
        }
        actions={incident && <StatusPill status={incident.status} />}
      />
      {incident && (
        <Panel>
          <div className="grid gap-2 sm:grid-cols-3">
            <SelectField
              label={t("incidentPage.status")}
              value={incident.status}
              disabled={!can("editor")}
              onChange={(e) => void patch({ status: e.target.value })}
              options={STATUSES(t)}
            />
            <SelectField
              label={t("incidentPage.severity")}
              value={incident.severity}
              disabled={!can("editor")}
              onChange={(e) => void patch({ severity: e.target.value })}
              options={sevOptions}
            />
            <TextField
              label={t("incidentPage.commander")}
              defaultValue={incident.commander ?? ""}
              disabled={!can("editor")}
              onBlur={(e) => e.target.value !== (incident.commander ?? "") && void patch({ commander: e.target.value || null })}
            />
          </div>
          <div className="mt-3 flex flex-col gap-1 text-sm">
            {incident.summary && <p className="incidents-prose m-0 text-fg-muted">{incident.summary}</p>}
            <span className="flex items-center gap-2">
              <span className="text-xs text-fg-muted">{t("incidentPage.products")}</span>
              <Products ids={incident.products} />
            </span>
            {error && <span className="text-xs text-danger-text">{error}</span>}
          </div>
          {can("admin") && (
            <div className="mt-3 border-t border-line pt-3">
              <Button icon={<Trash2 />} onClick={() => setRemoving(true)}>
                {t("incidentPage.deleteIncident")}
              </Button>
            </div>
          )}
          <Dialog
            open={removing}
            onOpenChange={setRemoving}
            title={t("incidentPage.delete", { key: incident.key })}
            description={t("incidentPage.itsTimelineTasksEvidenceLinks")}
            footer={
              <>
                <Button type="button" onClick={() => setRemoving(false)}>
                  {t("incidentPage.cancel")}
                </Button>
                <Button type="button" variant="primary" onClick={() => void remove()}>
                  {t("incidentPage.delete2")}
                </Button>
              </>
            }
          >
            <></>
          </Dialog>
        </Panel>
      )}
      {incident && (
        <>
          <Tabs<Section>
            label={t("incidentPage.incidentSections")}
            value={section}
            onChange={setSection}
            items={[
              { value: "timeline", label: t("incidentPage.timeline") },
              { value: "tasks", label: t("incidentPage.tasks", { openTasks: incident.openTasks }) },
              { value: "evidence", label: t("incidentPage.evidence") },
              { value: "postmortem", label: t("incidentPage.postmortem") },
            ]}
          />
          {section === "timeline" && <TimelinePanel incident={incident} call={call} onChange={changed} />}
          {section === "tasks" && <TasksPanel incident={incident} call={call} onChange={changed} />}
          {section === "evidence" && <EvidencePanel incident={incident} call={call} onChange={changed} />}
          {section === "postmortem" && <PostmortemPanel key={incident.postmortem?.updatedAt ?? "none"} incident={incident} call={call} onChange={changed} />}
        </>
      )}
    </>
  );
}

// ---------------------------------------------------------------- Setup

function Code({ children }: { children: ReactNode }) {
  return <pre className="m-0 overflow-x-auto rounded-md bg-subtle px-2.5 py-2 font-mono text-xs text-fg">{children}</pre>;
}

function SetupPage() {
  const t = useT();
  const origin = window.location.origin;
  return (
    <>
      <PageHeader title={t("setupPage.setup")} description={t("setupPage.peopleOpenIncidentsHereOther")} />
      <Panel title={t("setupPage.letAProductOpenIncidents")} description={t("setupPage.createAnApiTokenWith")}>
        <Code>{`curl -sf -X POST -H "Authorization: Bearer $INCIDENTS_API_TOKEN" -H 'content-type: application/json' \\
  -d '{"title":"Brute force on vpn","severity":"high","products":["siem","vpn"],"external":{"source":"siem","reference":"sig-42"}}' \\
  ${origin}/api/v1/incidents`}</Code>
      </Panel>
      <Panel title={t("setupPage.howAnIncidentRuns")} description={t("setupPage.openItWorkItResolve")}>
        <ul className="incidents-list flex flex-col gap-1 text-sm text-fg-muted">
          <li>{t("setupPage.aChangeOfStatusOr")}</li>
          <li>{t("setupPage.theTimelineIsAppendOnly")}</li>
          <li>{t("setupPage.evidenceIsALinkTo")}</li>
          <li>{t("setupPage.aPostmortemIsWrittenOnce")}</li>
        </ul>
      </Panel>
    </>
  );
}

// ---------------------------------------------------------------- Shell

/** Account, Members, Sign-in and API tokens: the screens come from @openasy/auth. */
function SettingsPage({ page }: { page: "account" | "members" | "signin" | "tokens" }) {
  const t = useT();
  const { signOut, can } = useAuth();
  if (page !== "account" && !can("admin")) return <EmptyState title={t("settingsPage.adminsOnly")}>{t("settingsPage.askAnAdminOfThis")}</EmptyState>;
  const titles = {
    account: ["Account", "Your profile, password, two-step verification and where you are signed in."],
    members: [
      "Members",
      "Who can sign in to this incidents, and with which role. Viewers read everything; editors also open and run incidents; admins also delete them, and manage members and tokens.",
    ],
    signin: [
      "Sign-in",
      "Identity providers people can sign in with, such as OpenAsy Identity, Keycloak or Microsoft Entra ID, and which of their groups give which role.",
    ],
    tokens: ["API tokens", "For scripts and other products. Each token has one role and an expiry; the secret is shown once."],
  } as const;
  return (
    <>
      <PageHeader
        title={titles[page][0]}
        description={titles[page][1]}
        actions={
          page === "account" && (
            <Button icon={<LogOut />} onClick={() => void signOut()}>
              {t("settingsPage.signOut")}
            </Button>
          )
        }
      />
      {page === "account" ? <AccountSettings /> : page === "members" ? <MembersSettings /> : page === "signin" ? <SignInSettings /> : <TokensSettings />}
    </>
  );
}

function Product() {
  const msg = useT();
  const [theme, setTheme] = useThemePreference();
  const { me, can } = useAuth();
  const route = parseRoute(usePath());
  const [summary, setSummary] = useState<Summary>();
  const [products, setProducts] = useState<Array<ProductLink & { id: ProductId }>>([]);
  const call = useApi();

  // The install's other products (OPENASY_PRODUCTS), for the switcher; ids this UI does not know are left out.
  useEffect(() => {
    void call<{ products: ProductLink[] }>("/api/v1/products").then(
      (r) =>
        setProducts(r.products.filter((p): p is ProductLink & { id: ProductId } => p.id !== "incidents" && (PRODUCT_IDS as readonly string[]).includes(p.id))),
      () => {},
    );
  }, [call]);

  const reload = useCallback(() => void call<Summary>("/api/v1/summary").then(setSummary, () => {}), [call]);
  useEffect(() => {
    reload();
    const t = setInterval(reload, 15_000);
    return () => clearInterval(t);
  }, [reload]);

  const nav = [
    { id: "incidents", label: msg("product.incidents"), icon: Siren, count: summary ? Object.values(summary.open).reduce((a, b) => a + b, 0) : undefined },
  ];
  const footerNav = [
    { id: "setup", label: msg("product.setup"), icon: Settings2 },
    ...(can("admin")
      ? [
          { id: "members", label: msg("product.members"), icon: Users },
          { id: "signin", label: msg("product.signIn"), icon: LogIn },
          { id: "tokens", label: msg("product.apiTokens"), icon: KeyRound },
        ]
      : []),
    { id: "account", label: msg("product.account"), icon: UserRound },
  ];
  const active = route.page === "incident" ? "incidents" : route.page;
  const roleName = me.user.role.charAt(0).toUpperCase() + me.user.role.slice(1);

  return (
    <AppShell
      product="incidents"
      nav={nav}
      activeNav={active}
      onNavigate={(id) => navigate(`/${id}`)}
      connectedProducts={products.map((p) => p.id)}
      onSwitchProduct={(id) => {
        const to = products.find((p) => p.id === id);
        if (to) window.location.assign(to.url);
      }}
      footerNav={footerNav}
      user={{ name: me.user.name, role: roleName }}
      theme={theme}
      onThemeChange={setTheme}
    >
      {route.page === "incidents" ? (
        <IncidentsPage call={call} summary={summary} reload={reload} />
      ) : route.page === "incident" ? (
        <IncidentPage key={route.id} call={call} id={route.id} reload={reload} />
      ) : route.page === "account" || route.page === "members" || route.page === "signin" || route.page === "tokens" ? (
        <SettingsPage page={route.page} />
      ) : (
        <SetupPage />
      )}
    </AppShell>
  );
}

export function App() {
  const [theme] = useThemePreference();
  return (
    // No organization until branding is configurable (ADR 0004); the library's default is a placeholder.
    <BrandProvider theme={theme} brand={{ name: "OpenAsy", organization: undefined }} className="min-h-screen">
      <AuthGate product="OpenAsy Incidents">
        <Product />
      </AuthGate>
    </BrandProvider>
  );
}
