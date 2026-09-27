"use client";
import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import GridLayout, { useContainerWidth, type Layout } from "react-grid-layout";
import type { EChartsType } from "echarts/core";
import { api, type Dashboard, type DashboardSpec, type FilterValue, type Widget, type WidgetType } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { saveBlob, uid } from "@/lib/data";
import { REFRESH_OPTIONS, WIDGET_TYPES, buildFilters, dateRangeValue, datasetForColumn, newWidget, normalizeSpec, type CrossFilter } from "@/lib/dashboard";
import { useTheme } from "@/lib/theme";
import { useToast } from "@/lib/toast";
import { WidgetFrame } from "@/components/dashboard/WidgetFrame";
import { WidgetBody } from "@/components/dashboard/WidgetBody";
import { WidgetConfigDrawer } from "@/components/dashboard/WidgetConfigDrawer";
import { FilterBar } from "@/components/dashboard/FilterBar";
import { ShareDialog } from "@/components/dashboard/ShareDialog";
import { SettingsDialog } from "@/components/dashboard/SettingsDialog";
import { exportDashboardPng } from "@/components/dashboard/exportPng";
import { CommentsPanel, openThreadCounts, useDashboardComments } from "@/components/dashboard/CommentsPanel";
import { Badge, Button, EmptyState, QueryState, SelectField, Tabs, cx } from "@/components/ui";

const ROW_HEIGHT = 36;

export default function DashboardPage() {
  const { id } = useParams<{ id: string }>();
  const q = useQuery({ queryKey: ["dashboard", id], queryFn: () => api.dashboards.get(id) });
  return <QueryState query={q}>{(d) => <DashboardView key={d.id} dashboard={d} />}</QueryState>;
}

function initialFilterValues(spec: DashboardSpec): Record<string, FilterValue | null> {
  return Object.fromEntries((spec.filters ?? []).filter((f) => f.column).map((f) => [f.column, f.default ?? null]));
}

function DashboardView({ dashboard }: { dashboard: Dashboard }) {
  const { can } = useAuth();
  const { dark } = useTheme();
  const toast = useToast();
  const qc = useQueryClient();
  const params = useSearchParams();
  const canEdit = can("dashboards.edit") && dashboard.your_role !== "viewer";
  const canModerate = dashboard.your_role === "owner" || dashboard.your_role === "editor" || can("tenant.manage");

  const [spec, setSpec] = useState<DashboardSpec>(() => normalizeSpec(dashboard.spec));
  const [name, setName] = useState(dashboard.name);
  const [savedJson, setSavedJson] = useState(() => JSON.stringify({ name: dashboard.name, spec: normalizeSpec(dashboard.spec) }));
  const [editing, setEditing] = useState(canEdit && params.get("edit") === "1");
  const [pageIdx, setPageIdx] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [filterValues, setFilterValues] = useState<Record<string, FilterValue | null>>(() => initialFilterValues(normalizeSpec(dashboard.spec)));
  const [datePreset, setDatePreset] = useState(spec.date_range?.default ?? "all");
  const [customRange, setCustomRange] = useState<{ from?: string; to?: string }>({});
  const [cross, setCross] = useState<CrossFilter[]>([]);
  const [refresh, setRefresh] = useState<number>(spec.refresh_seconds ?? 0);
  const [presenting, setPresenting] = useState(false);
  const [exportMenu, setExportMenu] = useState(false);
  const [commentScope, setCommentScope] = useState<string | null>(null);
  const comments = useDashboardComments(dashboard.id);
  const commentCounts = useMemo(() => openThreadCounts(comments.data), [comments.data]);
  const openComments = [...commentCounts.values()].reduce((a, b) => a + b, 0);
  const shellRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const charts = useRef(new Map<string, EChartsType>());
  const { width, containerRef, mounted } = useContainerWidth();

  const datasets = useQuery({ queryKey: ["datasets"], queryFn: () => api.datasets.list(), meta: { silent: true } });

  const dirty = JSON.stringify({ name, spec }) !== savedJson;
  const savedSpec = useMemo(() => (JSON.parse(savedJson) as { spec: DashboardSpec }).spec, [savedJson]);
  const savedConfigs = useMemo(() => new Map(savedSpec.pages.flatMap((p) => p.widgets.map((w) => [w.id, JSON.stringify(w.config)] as const))), [savedSpec]);

  const page = spec.pages[Math.min(pageIdx, spec.pages.length - 1)];

  const save = useMutation({
    mutationFn: () => api.dashboards.update(dashboard.id, { name, spec }),
    meta: { errorPrefix: "Dashboard not saved" },
    onSuccess: (d) => {
      const s = normalizeSpec(d?.spec ?? spec);
      // adopt the server's normalized spec so "unsaved changes" reflects real edits only
      setSpec(s);
      setName(d?.name ?? name);
      setSavedJson(JSON.stringify({ name: d?.name ?? name, spec: s }));
      qc.setQueryData(["dashboard", dashboard.id], d);
      qc.invalidateQueries({ queryKey: ["widget-data", dashboard.id] });
      qc.invalidateQueries({ queryKey: ["dashboards"] });
      toast.success("Dashboard saved");
    },
  });

  // warn about unsaved changes
  useEffect(() => {
    if (!dirty) return;
    const h = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [dirty]);

  // presentation mode (DSH-007)
  useEffect(() => {
    const onFs = () => setPresenting(document.fullscreenElement === shellRef.current);
    document.addEventListener("fullscreenchange", onFs);
    return () => document.removeEventListener("fullscreenchange", onFs);
  }, []);
  useEffect(() => {
    if (!presenting) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight") setPageIdx((i) => Math.min(spec.pages.length - 1, i + 1));
      if (e.key === "ArrowLeft") setPageIdx((i) => Math.max(0, i - 1));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [presenting, spec.pages.length]);

  const present = async () => {
    setEditing(false);
    setSelected(null);
    try {
      await shellRef.current?.requestFullscreen();
    } catch {
      toast.error("Full-screen mode is not available in this browser");
    }
  };

  // -- spec mutations ---------------------------------------------------------------
  const updatePage = (fn: (widgets: Widget[]) => Widget[]) => setSpec((s) => ({ ...s, pages: s.pages.map((p) => (p.id === page.id ? { ...p, widgets: fn(p.widgets) } : p)) }));
  const updateWidget = (w: Widget) => updatePage((ws) => ws.map((x) => (x.id === w.id ? w : x)));
  const addWidget = (type: WidgetType) => {
    const w = newWidget(type, page);
    updatePage((ws) => [...ws, w]);
    setSelected(w.id);
  };
  const removeWidget = (wid: string) => {
    updatePage((ws) => ws.filter((w) => w.id !== wid));
    charts.current.delete(wid);
    if (selected === wid) setSelected(null);
  };
  const duplicateWidget = (w: Widget) => updatePage((ws) => [...ws, { ...w, id: uid("w"), title: `${w.title} (copy)`, layout: { ...w.layout, y: w.layout.y + w.layout.h } }]);

  const onLayoutChange = useCallback(
    (layout: Layout) => {
      if (!editing) return;
      setSpec((s) => {
        let changed = false;
        const pages = s.pages.map((p) => {
          if (p.id !== page.id) return p;
          return {
            ...p,
            widgets: p.widgets.map((w) => {
              const l = layout.find((x) => x.i === w.id);
              if (!l || (l.x === w.layout.x && l.y === w.layout.y && l.w === w.layout.w && l.h === w.layout.h)) return w;
              changed = true;
              return { ...w, layout: { x: l.x, y: l.y, w: l.w, h: l.h } };
            }),
          };
        });
        return changed ? { ...s, pages } : s;
      });
    },
    [editing, page.id],
  );

  // -- filters -------------------------------------------------------------------------
  const dateRange = spec.date_range?.column ? { column: spec.date_range.column, value: dateRangeValue(datePreset, customRange) } : null;
  const filtersFor = (wid: string) => buildFilters(filterValues, dateRange, cross, wid);
  const onCrossFilter = (wid: string) => (column: string, value: string) =>
    setCross((c) => {
      const existing = c.find((x) => x.column === column);
      if (existing && existing.value === value) return c.filter((x) => x.column !== column); // toggle off
      return [...c.filter((x) => x.column !== column), { column, value, sourceWidgetId: wid }];
    });

  const allColumns = useMemo(() => {
    const ids = new Set(spec.pages.flatMap((p) => p.widgets.map((w) => w.config.dataset_id ?? w.config.filter?.dataset_id).filter(Boolean)));
    const cols = new Set<string>();
    datasets.data?.filter((d) => ids.has(d.id)).forEach((d) => d.schema?.entities?.[0]?.fields.forEach((f) => cols.add(f.name)));
    return [...cols].sort();
  }, [spec, datasets.data]);

  // -- export -----------------------------------------------------------------------------
  const exportServer = async (format: "html" | "json") => {
    setExportMenu(false);
    try {
      if (format === "json") {
        const d = await api.dashboards.get(dashboard.id);
        saveBlob(new Blob([JSON.stringify(d, null, 2)], { type: "application/json" }), `${name}.json`);
        return;
      }
      // Interactive HTML snapshot rendered by the API with the current filters (DSH-009a).
      const { blob, filename } = await api.dashboards.exportHtml(dashboard.id, buildFilters(filterValues, dateRange, cross));
      saveBlob(blob, filename ?? `${name}.html`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Export failed");
    }
  };
  const exportPng = async () => {
    setExportMenu(false);
    if (gridRef.current) await exportDashboardPng(gridRef.current, charts.current, { dark, filename: `${name}-${page.title}.png` });
  };

  const selectedWidget = page.widgets.find((w) => w.id === selected) ?? null;
  const narrow = mounted && width < 768;
  const accent = spec.theme?.primary;

  const renderWidget = (w: Widget) => (
    <WidgetFrame
      widget={w}
      editing={editing}
      selected={selected === w.id}
      accent={accent}
      onEdit={() => setSelected(w.id)}
      onRemove={() => removeWidget(w.id)}
      onDuplicate={() => duplicateWidget(w)}
      commentCount={presenting ? undefined : commentCounts.get(w.id) ?? 0}
      onComments={presenting ? undefined : () => setCommentScope(w.id)}
    >
      {(visible) => (
        <WidgetBody
          dashboardId={dashboard.id}
          widget={w}
          saved={savedConfigs.get(w.id) === JSON.stringify(w.config)}
          filters={filtersFor(w.id)}
          refreshMs={refresh * 1000}
          enabled={visible}
          onCrossFilter={onCrossFilter(w.id)}
          onChartReady={(c) => {
            if (c) charts.current.set(w.id, c);
            else charts.current.delete(w.id);
          }}
          filterValue={w.config.filter?.column ? filterValues[w.config.filter.column] : null}
          onFilterChange={(v) => w.config.filter?.column && setFilterValues((f) => ({ ...f, [w.config.filter!.column]: v }))}
        />
      )}
    </WidgetFrame>
  );

  const layout: Layout = page.widgets.map((w) => ({ i: w.id, ...w.layout, minW: 2, minH: 2 }));

  return (
    <div ref={shellRef} className={cx("space-y-4", presenting && "h-screen overflow-auto bg-[var(--surface-2)] p-6")}>
      {/* Toolbar */}
      {!presenting && (
        <div className="no-print flex flex-wrap items-center gap-2">
          <nav aria-label="Breadcrumb" className="text-xs text-[var(--text-2)]">
            <Link href="/dashboards" className="hover:underline">
              Dashboards
            </Link>{" "}
            /
          </nav>
          {editing ? (
            <>
              <label htmlFor="dash-name" className="sr-only">
                Dashboard name
              </label>
              <input id="dash-name" value={name} onChange={(e) => setName(e.target.value)} className="min-w-0 rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-lg font-semibold" />
            </>
          ) : (
            <h1 className="text-xl font-semibold">{name}</h1>
          )}
          {dirty && <Badge tone="warning">Unsaved changes</Badge>}
          <span className="flex-1" />
          <SelectField
            label="Auto-refresh"
            srOnlyLabel
            value={String(refresh)}
            onChange={(e) => setRefresh(Number(e.target.value))}
            options={REFRESH_OPTIONS.map((o) => ({ value: String(o.value), label: o.value ? `↻ every ${o.label}` : "↻ Auto-refresh off" }))}
          />
          <Button size="sm" onClick={() => qc.invalidateQueries({ queryKey: ["widget-data", dashboard.id] })} aria-label="Refresh all widgets">
            ↻
          </Button>
          <Button size="sm" onClick={present}>
            ⛶ Present
          </Button>
          <div className="relative">
            <Button size="sm" onClick={() => setExportMenu((o) => !o)} aria-expanded={exportMenu} aria-haspopup="menu">
              Export ▾
            </Button>
            {exportMenu && (
              <div role="menu" className="absolute right-0 z-30 mt-1 w-48 rounded-md border border-[var(--border)] bg-[var(--surface)] p-1 shadow-lg">
                <button role="menuitem" type="button" className="block w-full rounded px-3 py-1.5 text-left text-sm hover:bg-[var(--surface-2)]" onClick={exportPng}>
                  PNG image (this page)
                </button>
                <button role="menuitem" type="button" className="block w-full rounded px-3 py-1.5 text-left text-sm hover:bg-[var(--surface-2)]" onClick={() => { setExportMenu(false); setTimeout(() => window.print(), 50); }}>
                  PDF (print)
                </button>
                <button role="menuitem" type="button" className="block w-full rounded px-3 py-1.5 text-left text-sm hover:bg-[var(--surface-2)]" onClick={() => exportServer("html")}>
                  Interactive HTML
                </button>
                <button role="menuitem" type="button" className="block w-full rounded px-3 py-1.5 text-left text-sm hover:bg-[var(--surface-2)]" onClick={() => exportServer("json")}>
                  JSON spec
                </button>
              </div>
            )}
          </div>
          <Button size="sm" onClick={() => setCommentScope("")} aria-label={`Comments (${openComments} open)`}>
            Comments{openComments ? <Badge tone="info">{openComments}</Badge> : null}
          </Button>
          {canEdit && (
            <Button size="sm" onClick={() => setShareOpen(true)}>
              Share
            </Button>
          )}
          {canEdit &&
            (editing ? (
              <>
                <Button size="sm" onClick={() => setSettingsOpen(true)}>
                  Settings
                </Button>
                <Button size="sm" onClick={() => { setEditing(false); setSelected(null); }}>
                  Done editing
                </Button>
                <Button size="sm" variant="primary" onClick={() => save.mutate()} loading={save.isPending} disabled={!dirty}>
                  Save
                </Button>
              </>
            ) : (
              <Button size="sm" variant="primary" onClick={() => setEditing(true)}>
                Edit
              </Button>
            ))}
        </div>
      )}
      {presenting && (
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-semibold">{name}</h1>
          <span className="text-sm text-[var(--text-2)]">{page.title}</span>
          <span className="flex-1" />
          <span className="text-xs text-[var(--text-2)]">← → pages · Esc exits</span>
        </div>
      )}

      {/* Pages (DSH-003) */}
      {(spec.pages.length > 1 || editing) && (
        <div className="no-print flex flex-wrap items-end gap-2">
          <Tabs label="Dashboard pages" tabs={spec.pages.map((p, i) => ({ id: String(i), label: p.title }))} active={String(Math.min(pageIdx, spec.pages.length - 1))} onChange={(v) => setPageIdx(Number(v))} className="flex-1" />
          {editing && (
            <>
              <label htmlFor="page-title" className="sr-only">
                Page title
              </label>
              <input
                id="page-title"
                value={page.title}
                onChange={(e) => setSpec((s) => ({ ...s, pages: s.pages.map((p) => (p.id === page.id ? { ...p, title: e.target.value } : p)) }))}
                className="w-36 rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-sm"
              />
              <Button
                size="sm"
                onClick={() => {
                  setSpec((s) => ({ ...s, pages: [...s.pages, { id: uid("p"), title: `Page ${s.pages.length + 1}`, widgets: [] }] }));
                  setPageIdx(spec.pages.length);
                }}
              >
                + Page
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={spec.pages.length <= 1}
                onClick={() => {
                  setSpec((s) => ({ ...s, pages: s.pages.filter((p) => p.id !== page.id) }));
                  setPageIdx(0);
                }}
              >
                Delete page
              </Button>
            </>
          )}
        </div>
      )}

      <FilterBar
        filters={spec.filters ?? []}
        values={filterValues}
        onChange={(column, v) => setFilterValues((f) => ({ ...f, [column]: v }))}
        datasetFor={(c) => datasetForColumn(datasets.data, spec, c)}
        dateColumn={spec.date_range?.column ?? null}
        datePreset={datePreset}
        onDatePreset={setDatePreset}
        customRange={customRange}
        onCustomRange={setCustomRange}
        cross={cross}
        onClearCross={(column) => setCross((c) => (column ? c.filter((x) => x.column !== column) : []))}
      />

      {/* Widget palette */}
      {editing && (
        <div className="no-print flex flex-wrap gap-2 rounded-lg border border-dashed border-[var(--border)] p-2" role="group" aria-label="Add widget">
          <span className="self-center px-1 text-xs font-medium text-[var(--text-2)]">Add widget:</span>
          {WIDGET_TYPES.map((t) => (
            <Button key={t.type} size="sm" onClick={() => addWidget(t.type)} title={t.description}>
              + {t.label}
            </Button>
          ))}
        </div>
      )}

      {/* Grid (DSH-002) */}
      <div ref={containerRef} className="print-full">
        <div ref={gridRef}>
          {page.widgets.length === 0 ? (
            <EmptyState title="This page is empty">{canEdit ? (editing ? "Add a widget from the palette above." : "Click Edit to add widgets.") : "Nothing to show yet."}</EmptyState>
          ) : narrow && !editing ? (
            <div className="flex flex-col gap-3">
              {[...page.widgets]
                .sort((a, b) => a.layout.y - b.layout.y || a.layout.x - b.layout.x)
                .map((w) => (
                  <div key={w.id} style={{ height: Math.max(160, w.layout.h * ROW_HEIGHT) }}>
                    {renderWidget(w)}
                  </div>
                ))}
            </div>
          ) : (
            mounted && (
              <GridLayout
                layout={layout}
                width={width}
                gridConfig={{ cols: 12, rowHeight: ROW_HEIGHT, margin: [12, 12], containerPadding: [0, 0] }}
                dragConfig={{ enabled: editing, handle: ".widget-drag", cancel: "button, input, select, textarea, a" }}
                resizeConfig={{ enabled: editing, handles: ["se"] }}
                onLayoutChange={onLayoutChange}
              >
                {page.widgets.map((w) => (
                  <div key={w.id}>{renderWidget(w)}</div>
                ))}
              </GridLayout>
            )
          )}
        </div>
      </div>

      <WidgetConfigDrawer widget={selectedWidget} onChange={updateWidget} onClose={() => setSelected(null)} />
      <SettingsDialog
        spec={spec}
        columns={allColumns}
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        onChange={(s) => {
          setSpec(s);
          if (s.refresh_seconds !== spec.refresh_seconds) setRefresh(s.refresh_seconds ?? 0);
          if (s.date_range?.default !== spec.date_range?.default) setDatePreset(s.date_range?.default ?? "all");
        }}
      />
      <ShareDialog dashboardId={dashboard.id} open={shareOpen} onClose={() => setShareOpen(false)} />
      {commentScope !== null && (
        <CommentsPanel
          dashboardId={dashboard.id}
          widgets={spec.pages.flatMap((p) => p.widgets)}
          scope={commentScope}
          onScope={setCommentScope}
          canModerate={canModerate}
          onClose={() => setCommentScope(null)}
        />
      )}
    </div>
  );
}
