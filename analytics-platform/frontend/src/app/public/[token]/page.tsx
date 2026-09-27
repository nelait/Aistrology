"use client";
/** Anonymous, view-only dashboard behind a public link (SHR-001a). No credentials are sent. */
import { useParams } from "next/navigation";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, type FilterValue, type Widget } from "@/lib/api";
import { normalizeSpec } from "@/lib/dashboard";
import { WidgetBody, type WidgetDataArgs } from "@/components/dashboard/WidgetBody";
import { ErrorState, Spinner, TabPanel, Tabs } from "@/components/ui";

const ROW_HEIGHT = 36;
const NO_FILTERS: Record<string, FilterValue> = {};

export default function PublicDashboardPage() {
  const { token } = useParams<{ token: string }>();
  const q = useQuery({ queryKey: ["public-dashboard", token], queryFn: () => api.dashboards.publicView(token), retry: false, meta: { silent: true } });
  const [pageId, setPageId] = useState<string | null>(null);

  if (q.isLoading) return <Spinner className="p-8" label="Loading dashboard…" />;
  if (q.isError || !q.data)
    return (
      <main className="mx-auto max-w-xl p-8">
        <ErrorState error={new Error("This link is invalid, expired or has been revoked.")} />
      </main>
    );
  const spec = normalizeSpec(q.data.spec);
  const page = spec.pages.find((p) => p.id === pageId) ?? spec.pages[0];
  const fetcher: NonNullable<WidgetDataArgs["fetcher"]> = (widgetId, filters, signal) => api.dashboards.publicWidgetData(token, widgetId, filters, signal);

  return (
    <main className="mx-auto max-w-[1400px] space-y-4 p-4 lg:p-6">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-xl font-semibold">{q.data.name}</h1>
        <p className="text-xs text-[var(--text-2)]">View-only public link</p>
      </header>
      {spec.pages.length > 1 && <Tabs label="Dashboard pages" tabs={spec.pages.map((p) => ({ id: p.id, label: p.title }))} active={page.id} onChange={setPageId} />}
      <TabPanel id={page.id} className="pt-2">
        <div className="grid grid-cols-1 gap-3 md:grid-cols-12" style={{ gridAutoRows: `${ROW_HEIGHT}px` }}>
          {[...page.widgets]
            .sort((a, b) => a.layout.y - b.layout.y || a.layout.x - b.layout.x)
            .map((w) => (
              <section
                key={w.id}
                aria-label={w.title}
                className="flex min-h-0 flex-col overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--surface)] p-3 md:[grid-column:var(--gc)] md:[grid-row:var(--gr)]"
                style={{ "--gc": `${w.layout.x + 1} / span ${Math.min(12, w.layout.w)}`, "--gr": `${w.layout.y + 1} / span ${w.layout.h}`, minHeight: w.layout.h * ROW_HEIGHT } as React.CSSProperties}
              >
                {w.title && w.type !== "text" && <h2 className="mb-1 truncate text-sm font-semibold">{w.title}</h2>}
                <div className="min-h-0 flex-1">
                  <PublicWidget widget={w} dashboardId={q.data.id} fetcher={fetcher} />
                </div>
              </section>
            ))}
        </div>
      </TabPanel>
    </main>
  );
}

function PublicWidget({ widget, dashboardId, fetcher }: { widget: Widget; dashboardId: string; fetcher: NonNullable<WidgetDataArgs["fetcher"]> }) {
  if (widget.type === "prediction" || widget.type === "filter") return <p className="text-sm text-[var(--text-2)]">Not available in the public view.</p>;
  return <WidgetBody dashboardId={dashboardId} widget={widget} saved filters={NO_FILTERS} refreshMs={0} enabled fetcher={fetcher} />;
}
