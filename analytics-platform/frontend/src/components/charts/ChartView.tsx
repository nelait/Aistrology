"use client";
import { useMemo, useRef, useState } from "react";
import type { EChartsType } from "echarts/core";
import type { ChartSpec, Row } from "@/lib/types";
import { buildChartOption, inferColumns } from "@/lib/chartOptions";
import { columnsOf, exportRows, saveBlob } from "@/lib/data";
import { formatNumber } from "@/lib/format";
import { useTheme } from "@/lib/theme";
import { DataGrid } from "../DataGrid";
import { Button } from "../ui";
import { EChart } from "./EChart";

export interface ChartViewProps {
  rows: Row[];
  columns?: string[];
  spec: ChartSpec;
  height?: number | string;
  title?: string;
  toolbar?: boolean;
  onPointClick?: (column: string, value: string) => void;
  onReady?: (chart: EChartsType | null) => void;
}

function slug(s: string) {
  return s.replace(/[^A-Za-z0-9_-]+/g, "_").slice(0, 60) || "chart";
}

/** Chart + accessible table view + PNG/SVG/CSV/JSON export (VIZ-002, VIZ-004, VIZ-005). */
export function ChartView({ rows, columns, spec, height = 300, title = "chart", toolbar = true, onPointClick, onReady }: ChartViewProps) {
  const { dark } = useTheme();
  const chartRef = useRef<EChartsType | null>(null);
  const [asTable, setAsTable] = useState(false);
  const cols = useMemo(() => columnsOf(rows, columns), [rows, columns]);
  const option = useMemo(() => buildChartOption({ rows, columns: cols, spec, dark }), [rows, cols, spec, dark]);
  const { x, y } = inferColumns(rows, cols, spec);

  if (spec.type === "kpi") {
    const v = y ? rows[0]?.[y] : rows[0]?.[cols[0]];
    return (
      <div className="flex h-full flex-col items-center justify-center" style={{ minHeight: typeof height === "number" ? Math.min(height, 160) : undefined }}>
        <p className="text-4xl font-semibold tabular-nums">{formatNumber(v)}</p>
        <p className="text-sm text-[var(--text-2)]">{y ?? cols[0]}</p>
      </div>
    );
  }
  if (spec.type === "table") return <DataGrid columns={cols} rows={rows} pageSize={10} dense caption={title} />;

  const exportPng = () => {
    const url = chartRef.current?.getDataURL({ type: "png", pixelRatio: 2, backgroundColor: dark ? "#1a1a19" : "#ffffff" });
    if (url)
      fetch(url)
        .then((r) => r.blob())
        .then((b) => saveBlob(b, `${slug(title)}.png`));
  };
  const exportSvg = async () => {
    if (!option) return;
    const { renderSvg } = await import("./echarts");
    const el = chartRef.current;
    const svg = renderSvg(option, el?.getWidth() ?? 800, el?.getHeight() ?? 400);
    saveBlob(new Blob([svg], { type: "image/svg+xml" }), `${slug(title)}.svg`);
  };

  return (
    <div className="flex h-full min-h-0 flex-col gap-1">
      {toolbar && (
        <div className="no-print flex flex-wrap justify-end gap-1">
          <Button size="sm" variant="ghost" onClick={() => setAsTable((v) => !v)} aria-pressed={asTable}>
            {asTable ? "Chart view" : "Table view"}
          </Button>
          {!asTable && option && (
            <>
              <Button size="sm" variant="ghost" onClick={exportPng}>
                PNG
              </Button>
              <Button size="sm" variant="ghost" onClick={exportSvg}>
                SVG
              </Button>
            </>
          )}
          <Button size="sm" variant="ghost" onClick={() => exportRows(cols, rows, "csv", slug(title))}>
            CSV
          </Button>
          <Button size="sm" variant="ghost" onClick={() => exportRows(cols, rows, "json", slug(title))}>
            JSON
          </Button>
        </div>
      )}
      <div className="min-h-0 flex-1">
        {asTable ? (
          <DataGrid columns={cols} rows={rows} pageSize={10} dense caption={title} filterable={false} maxHeight={height} />
        ) : option ? (
          <EChart
            option={option}
            height={height}
            ariaLabel={`${spec.type} chart: ${title}${x ? `, ${x}` : ""}${y ? ` by ${y}` : ""}. Use "Table view" for the data.`}
            onReady={(c) => {
              chartRef.current = c;
              onReady?.(c);
            }}
            onClick={
              onPointClick && x
                ? (p) => {
                    if (p.name !== undefined && p.name !== "") onPointClick(x, String(p.name));
                  }
                : undefined
            }
          />
        ) : (
          <p className="grid h-full place-items-center p-4 text-center text-sm text-[var(--text-2)]">
            {rows.length ? `Can't draw a ${spec.type} chart from these columns. Pick x/y columns that fit the chart type.` : "No data"}
          </p>
        )}
      </div>
    </div>
  );
}
