/**
 * Builds Apache ECharts options for every chart type in VIZ-001/VIZ-001a from tabular rows.
 * Colors follow a validated categorical palette (fixed order, stepped separately for dark mode);
 * sequential encodings use a single blue ramp; waterfall uses a blue/red diverging pair.
 */
import type { EChartsOption } from "echarts";
import type { ChartSpec, Row } from "./types";
import { toNumber } from "./data";

export const PALETTE_LIGHT = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#4a3aa7", "#e34948"];
export const PALETTE_DARK = ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9", "#e66767"];
export const SEQUENTIAL = ["#cde2fb", "#9ec5f4", "#6da7ec", "#3987e5", "#256abf", "#184f95", "#0d366b"];
export const STATUS = { good: "#008300", warning: "#eda100", serious: "#eb6834", critical: "#e34948" };
const MAX_CATEGORIES = 8;

export interface ChartTheme {
  dark: boolean;
}

function ink(dark: boolean) {
  return {
    primary: dark ? "#ffffff" : "#0b0b0b",
    secondary: dark ? "#c3c2b7" : "#52514e",
    muted: dark ? "#8a8983" : "#8a8983",
    grid: dark ? "#383835" : "#e7e6e2",
    surface: dark ? "#1a1a19" : "#fcfcfb",
  };
}

export function palette(dark: boolean): string[] {
  return dark ? PALETTE_DARK : PALETTE_LIGHT;
}

function isNumericColumn(rows: Row[], col: string): boolean {
  let seen = 0;
  for (const r of rows.slice(0, 200)) {
    const v = r[col];
    if (v === null || v === undefined || v === "") continue;
    if (typeof v === "number") seen++;
    else if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) seen++;
    else return false;
  }
  return seen > 0;
}

export function inferColumns(rows: Row[], columns: string[] | undefined, spec: ChartSpec): { x: string | null; y: string | null; series: string | null } {
  const cols = columns?.length ? columns : rows[0] ? Object.keys(rows[0]) : [];
  const numeric = cols.filter((c) => isNumericColumn(rows, c));
  const x = spec.x && cols.includes(spec.x) ? spec.x : cols.find((c) => !numeric.includes(c)) ?? cols[0] ?? null;
  const y = spec.y && cols.includes(spec.y) ? spec.y : numeric.find((c) => c !== x) ?? null;
  const series = spec.series && cols.includes(spec.series) ? spec.series : null;
  return { x, y, series };
}

type Agg = NonNullable<ChartSpec["aggregation"]>;

function reduce(values: number[], agg: Agg | null | undefined): number {
  if (!values.length) return 0;
  switch (agg) {
    case "avg":
      return values.reduce((a, b) => a + b, 0) / values.length;
    case "count":
      return values.length;
    case "min":
      return Math.min(...values);
    case "max":
      return Math.max(...values);
    default:
      return values.reduce((a, b) => a + b, 0);
  }
}

function key(v: unknown): string {
  if (v === null || v === undefined) return "(null)";
  return typeof v === "object" ? JSON.stringify(v) : String(v);
}

/** Group rows by x (and series) and reduce y. Keeps first-appearance order. */
export function aggregateRows(rows: Row[], x: string, y: string | null, series: string | null, agg: Agg | null | undefined) {
  const categories: string[] = [];
  const seriesNames: string[] = [];
  const buckets = new Map<string, Map<string, number[]>>();
  for (const r of rows) {
    const cx = key(r[x]);
    const cs = series ? key(r[series]) : "";
    if (!buckets.has(cs)) {
      buckets.set(cs, new Map());
      seriesNames.push(cs);
    }
    if (!categories.includes(cx)) categories.push(cx);
    const m = buckets.get(cs)!;
    if (!m.has(cx)) m.set(cx, []);
    const n = y ? toNumber(r[y]) : 1;
    if (n !== null) m.get(cx)!.push(n);
    else if (agg === "count" || !y) m.get(cx)!.push(1);
  }
  const effectiveAgg: Agg | null | undefined = y ? agg : "count";
  const data = seriesNames.map((s) => ({
    name: s,
    values: categories.map((c) => {
      const vals = buckets.get(s)!.get(c);
      return vals && vals.length ? reduce(vals, effectiveAgg) : null;
    }),
  }));
  return { categories, series: data };
}

function quantile(sorted: number[], q: number): number {
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

export function boxStats(values: number[]): { box: [number, number, number, number, number]; outliers: number[] } | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const q1 = quantile(s, 0.25);
  const med = quantile(s, 0.5);
  const q3 = quantile(s, 0.75);
  const iqr = q3 - q1;
  const loF = q1 - 1.5 * iqr;
  const hiF = q3 + 1.5 * iqr;
  const inside = s.filter((v) => v >= loF && v <= hiF);
  return {
    box: [inside[0] ?? s[0], q1, med, q3, inside[inside.length - 1] ?? s[s.length - 1]],
    outliers: s.filter((v) => v < loF || v > hiF),
  };
}

export function histogramBins(values: number[], bins?: number): { edges: number[]; counts: number[] } {
  if (!values.length) return { edges: [], counts: [] };
  const min = Math.min(...values);
  const max = Math.max(...values);
  const n = bins ?? Math.min(40, Math.max(5, Math.ceil(Math.log2(values.length) + 1)));
  if (min === max) return { edges: [min, max], counts: [values.length] };
  const width = (max - min) / n;
  const counts = new Array<number>(n).fill(0);
  for (const v of values) counts[Math.min(n - 1, Math.floor((v - min) / width))]++;
  const edges = Array.from({ length: n + 1 }, (_, i) => min + i * width);
  return { edges, counts };
}

function fmtEdge(v: number): string {
  return Math.abs(v) >= 1000 ? v.toFixed(0) : Number(v.toPrecision(3)).toString();
}

function base(dark: boolean): EChartsOption {
  const t = ink(dark);
  return {
    backgroundColor: "transparent",
    color: palette(dark),
    textStyle: { color: t.secondary, fontFamily: "inherit" },
    animationDuration: 300,
    tooltip: { confine: true },
  };
}

function axisStyle(dark: boolean) {
  const t = ink(dark);
  return {
    axisLine: { lineStyle: { color: t.grid } },
    axisTick: { show: false },
    axisLabel: { color: t.secondary, hideOverlap: true },
    splitLine: { lineStyle: { color: t.grid, type: "dashed" as const } },
    nameTextStyle: { color: t.secondary },
  };
}

function legend(dark: boolean, show: boolean): EChartsOption["legend"] {
  return show ? { show: true, top: 0, type: "scroll", textStyle: { color: ink(dark).secondary }, icon: "roundRect" } : { show: false };
}

export interface BuildInput {
  rows: Row[];
  columns?: string[];
  spec: ChartSpec;
  dark?: boolean;
  /** Extra settings for gauge (max) or histogram (bins). */
  gaugeMax?: number;
  bins?: number;
}

/** Returns null when the chart cannot be drawn from the data (the caller shows an empty state). */
export function buildChartOption({ rows, columns, spec, dark = false, gaugeMax, bins }: BuildInput): EChartsOption | null {
  if (!rows.length) return null;
  const type = spec.type;
  const { x, y, series } = inferColumns(rows, columns, spec);
  const opt = base(dark);
  const ax = axisStyle(dark);
  const pal = palette(dark);
  const t = ink(dark);
  const grid = { left: 8, right: 16, top: 36, bottom: 8, containLabel: true };

  switch (type) {
    case "bar":
    case "line":
    case "area": {
      if (!x) return null;
      const agg = aggregateRows(rows, x, y, series, spec.aggregation);
      const multi = agg.series.length > 1;
      const shown = agg.series.slice(0, MAX_CATEGORIES);
      const many = agg.categories.length > 30;
      return {
        ...opt,
        grid: { ...grid, bottom: many ? 40 : 8 },
        legend: legend(dark, multi),
        tooltip: { trigger: "axis", confine: true, axisPointer: { type: type === "bar" ? "shadow" : "line" } },
        xAxis: { type: "category", data: agg.categories, name: x, nameLocation: "middle", nameGap: 28, ...ax, splitLine: { show: false } },
        yAxis: { type: "value", name: y ?? "count", ...ax },
        dataZoom: many ? [{ type: "inside" }, { type: "slider", height: 16, bottom: 4 }] : [{ type: "inside", disabled: true }],
        series: shown.map((s) => ({
          name: s.name || (y ?? "count"),
          type: type === "bar" ? "bar" : "line",
          data: s.values,
          smooth: false,
          showSymbol: agg.categories.length <= 40,
          symbolSize: 8,
          lineStyle: { width: 2 },
          areaStyle: type === "area" ? { opacity: 0.18 } : undefined,
          stack: type === "area" && multi ? "total" : undefined,
          barMaxWidth: 36,
          itemStyle: type === "bar" ? { borderRadius: [4, 4, 0, 0], borderColor: t.surface, borderWidth: multi ? 1 : 0 } : undefined,
          emphasis: { focus: "series" },
        })),
      };
    }
    case "scatter": {
      const xs = x && isNumericColumn(rows, x) ? x : (columns ?? Object.keys(rows[0])).find((c) => isNumericColumn(rows, c) && c !== y) ?? x;
      if (!xs || !y) return null;
      const groups = new Map<string, [number, number][]>();
      for (const r of rows) {
        const a = toNumber(r[xs]);
        const b = toNumber(r[y]);
        if (a === null || b === null) continue;
        const g = series ? key(r[series]) : y;
        if (!groups.has(g)) groups.set(g, []);
        groups.get(g)!.push([a, b]);
      }
      const entries = [...groups.entries()].slice(0, 3); // scatter: all-pairs palette cap
      return {
        ...opt,
        grid,
        legend: legend(dark, entries.length > 1),
        tooltip: { trigger: "item", confine: true },
        xAxis: { type: "value", name: xs, nameLocation: "middle", nameGap: 28, scale: true, ...ax },
        yAxis: { type: "value", name: y, scale: true, ...ax },
        dataZoom: [{ type: "inside", xAxisIndex: 0 }, { type: "inside", yAxisIndex: 0 }],
        series: entries.map(([name, data]) => ({
          name,
          type: "scatter",
          data,
          symbolSize: 8,
          itemStyle: { opacity: 0.8, borderColor: t.surface, borderWidth: 1 },
        })),
      };
    }
    case "pie": {
      if (!x) return null;
      const agg = aggregateRows(rows, x, y, null, spec.aggregation);
      let items = agg.categories.map((c, i) => ({ name: c, value: agg.series[0].values[i] ?? 0 }));
      items.sort((a, b) => b.value - a.value);
      if (items.length > MAX_CATEGORIES) {
        const rest = items.slice(MAX_CATEGORIES - 1).reduce((a, b) => a + b.value, 0);
        items = [...items.slice(0, MAX_CATEGORIES - 1), { name: "Other", value: rest }];
      }
      return {
        ...opt,
        legend: legend(dark, true),
        tooltip: { trigger: "item", confine: true, formatter: "{b}: {c} ({d}%)" },
        series: [
          {
            type: "pie",
            radius: ["45%", "70%"],
            center: ["50%", "55%"],
            data: items,
            itemStyle: { borderColor: t.surface, borderWidth: 2, borderRadius: 4 },
            label: { color: t.secondary, formatter: "{b}" },
          },
        ],
      };
    }
    case "heatmap": {
      if (!x) return null;
      const yCat = series ?? (y && !isNumericColumn(rows, y) ? y : null);
      const valueCol = series ? y : yCat === y ? null : y;
      if (!yCat) return null;
      const xs: string[] = [];
      const ys: string[] = [];
      const cells = new Map<string, number[]>();
      for (const r of rows) {
        const a = key(r[x]);
        const b = key(r[yCat]);
        if (!xs.includes(a)) xs.push(a);
        if (!ys.includes(b)) ys.push(b);
        const k = `${a}\u0000${b}`;
        if (!cells.has(k)) cells.set(k, []);
        const n = valueCol ? toNumber(r[valueCol]) : 1;
        if (n !== null) cells.get(k)!.push(n);
      }
      const data: [number, number, number][] = [];
      cells.forEach((vals, k) => {
        const [a, b] = k.split("\u0000");
        data.push([xs.indexOf(a), ys.indexOf(b), reduce(vals, valueCol ? spec.aggregation : "count")]);
      });
      const values = data.map((d) => d[2]);
      return heatmapOption(opt, ax, xs, ys, data, Math.min(...values), Math.max(...values), dark, x, yCat);
    }
    case "histogram": {
      const col = spec.x && isNumericColumn(rows, spec.x) ? spec.x : y ?? x;
      if (!col) return null;
      // Pre-binned results (a label column plus a count) are drawn as-is.
      if (spec.x && spec.y && !isNumericColumn(rows, spec.x) && isNumericColumn(rows, spec.y)) {
        return buildChartOption({ rows, columns, spec: { ...spec, type: "bar" }, dark });
      }
      const values = rows.map((r) => toNumber(r[col])).filter((v): v is number => v !== null);
      const h = histogramBins(values, bins);
      return histogramOption(opt, ax, h, col, dark);
    }
    case "box": {
      if (!y) return null;
      const groups = new Map<string, number[]>();
      const byX = x && x !== y && !isNumericColumn(rows, x) ? x : null;
      for (const r of rows) {
        const n = toNumber(r[y]);
        if (n === null) continue;
        const g = byX ? key(r[byX]) : y;
        if (!groups.has(g)) groups.set(g, []);
        groups.get(g)!.push(n);
      }
      const cats = [...groups.keys()].slice(0, 30);
      const stats = cats.map((c) => boxStats(groups.get(c)!)!);
      return {
        ...opt,
        grid,
        tooltip: { trigger: "item", confine: true },
        xAxis: { type: "category", data: cats, name: byX ?? "", ...ax, splitLine: { show: false } },
        yAxis: { type: "value", name: y, scale: true, ...ax },
        series: [
          { name: y, type: "boxplot", data: stats.map((s) => s.box), itemStyle: { color: dark ? "#184f95" : "#cde2fb", borderColor: pal[0], borderWidth: 2 } },
          {
            name: "outliers",
            type: "scatter",
            symbolSize: 8,
            data: stats.flatMap((s, i) => s.outliers.map((o) => [i, o])),
            itemStyle: { color: pal[1] },
          },
        ],
      };
    }
    case "treemap": {
      if (!x) return null;
      if (series) {
        const children = new Map<string, Map<string, number>>();
        for (const r of rows) {
          const parent = key(r[x]);
          const child = key(r[series]);
          const n = y ? toNumber(r[y]) ?? 0 : 1;
          if (!children.has(parent)) children.set(parent, new Map());
          const m = children.get(parent)!;
          m.set(child, (m.get(child) ?? 0) + n);
        }
        return treemapOption(
          opt,
          [...children.entries()].map(([name, m]) => ({ name, children: [...m.entries()].map(([n, v]) => ({ name: n, value: v })) })),
          dark,
        );
      }
      const agg = aggregateRows(rows, x, y, null, spec.aggregation);
      return treemapOption(
        opt,
        agg.categories.map((c, i) => ({ name: c, value: agg.series[0].values[i] ?? 0 })),
        dark,
      );
    }
    case "funnel": {
      if (!x) return null;
      const agg = aggregateRows(rows, x, y, null, spec.aggregation);
      const items = agg.categories.map((c, i) => ({ name: c, value: agg.series[0].values[i] ?? 0 }));
      const ramp = dark ? ["#6da7ec", "#5598e7", "#3987e5", "#2a78d6", "#256abf", "#1c5cab", "#184f95"] : ["#0d366b", "#104281", "#184f95", "#1c5cab", "#256abf", "#2a78d6", "#3987e5", "#5598e7", "#6da7ec", "#86b6ef"];
      return {
        ...opt,
        tooltip: { trigger: "item", confine: true, formatter: "{b}: {c}" },
        series: [
          {
            type: "funnel",
            sort: "none",
            top: 16,
            bottom: 16,
            left: "10%",
            width: "80%",
            gap: 2,
            data: items.map((it, i) => ({ ...it, itemStyle: { color: ramp[Math.min(i, ramp.length - 1)] } })),
            label: { color: dark ? "#ffffff" : "#ffffff", formatter: "{b}: {c}" },
            itemStyle: { borderColor: t.surface, borderWidth: 2 },
          },
        ],
      };
    }
    case "gauge": {
      const col = y ?? x;
      if (!col) return null;
      const vals = rows.map((r) => toNumber(r[col])).filter((v): v is number => v !== null);
      const value = vals.length === 1 ? vals[0] : reduce(vals, spec.aggregation ?? "sum");
      const max = gaugeMax ?? niceMax(value);
      return gaugeOption(opt, value, max, col, dark);
    }
    case "sankey": {
      const cols = columns?.length ? columns : Object.keys(rows[0]);
      const categorical = cols.filter((c) => !isNumericColumn(rows, c));
      const src = spec.x ?? categorical[0];
      const tgt = spec.series ?? categorical.find((c) => c !== src);
      if (!src || !tgt) return null;
      const valCol = spec.y && isNumericColumn(rows, spec.y) ? spec.y : cols.find((c) => isNumericColumn(rows, c)) ?? null;
      const links = new Map<string, number>();
      const nodes = new Set<string>();
      for (const r of rows) {
        const a = `${key(r[src])}`;
        const b = `${key(r[tgt])}`;
        const bName = nodes.has(b) || a !== b ? b : `${b} `;
        if (a === bName) continue;
        nodes.add(a);
        nodes.add(bName);
        const k = `${a}\u0000${bName}`;
        links.set(k, (links.get(k) ?? 0) + (valCol ? toNumber(r[valCol]) ?? 0 : 1));
      }
      return {
        ...opt,
        tooltip: { trigger: "item", confine: true },
        series: [
          {
            type: "sankey",
            emphasis: { focus: "adjacency" },
            nodeGap: 10,
            data: [...nodes].map((n, i) => ({ name: n, itemStyle: { color: pal[i % 3] } })),
            links: [...links.entries()].map(([k, v]) => {
              const [source, target] = k.split("\u0000");
              return { source, target, value: v };
            }),
            lineStyle: { color: "gradient", opacity: 0.35 },
            label: { color: t.primary },
          },
        ],
      };
    }
    case "waterfall": {
      if (!x || !y) return null;
      const agg = aggregateRows(rows, x, y, null, spec.aggregation ?? "sum");
      const deltas = agg.series[0].values.map((v) => v ?? 0);
      return waterfallOption(opt, ax, agg.categories, deltas, dark, y);
    }
    default:
      return null;
  }
}

function niceMax(v: number): number {
  if (v <= 0) return 100;
  if (v <= 1) return 1;
  if (v <= 100) return 100;
  const mag = Math.pow(10, Math.floor(Math.log10(v)));
  return Math.ceil((v * 1.2) / mag) * mag;
}

export function heatmapOption(
  opt: EChartsOption,
  ax: ReturnType<typeof axisStyle>,
  xs: string[],
  ys: string[],
  data: [number, number, number | null][],
  min: number,
  max: number,
  dark: boolean,
  xName = "",
  yName = "",
  diverging = false,
): EChartsOption {
  const t = ink(dark);
  const colors = diverging
    ? dark
      ? ["#3987e5", "#383835", "#e66767"]
      : ["#2a78d6", "#f0efec", "#e34948"]
    : dark
      ? [...SEQUENTIAL].reverse()
      : SEQUENTIAL;
  return {
    ...opt,
    grid: { left: 8, right: 16, top: 16, bottom: 48, containLabel: true },
    tooltip: {
      confine: true,
      formatter: (p: unknown) => {
        const d = (p as { data: [number, number, number | null] }).data;
        return `${xs[d[0]]} × ${ys[d[1]]}: <b>${d[2] === null ? "—" : Number(d[2].toPrecision(4))}</b>`;
      },
    },
    xAxis: { type: "category", data: xs, name: xName, ...ax, splitLine: { show: false }, axisLabel: { ...ax.axisLabel, rotate: xs.length > 8 ? 30 : 0 } },
    yAxis: { type: "category", data: ys, name: yName, ...ax, splitLine: { show: false } },
    visualMap: {
      min,
      max: max === min ? min + 1 : max,
      calculable: true,
      orient: "horizontal",
      left: "center",
      bottom: 0,
      itemHeight: 120,
      textStyle: { color: t.secondary },
      inRange: { color: colors },
    },
    series: [
      {
        type: "heatmap",
        data,
        label: { show: xs.length * ys.length <= 100, color: t.primary, formatter: (p: unknown) => {
          const v = (p as { data: [number, number, number | null] }).data[2];
          return v === null ? "" : String(Number(v.toPrecision(2)));
        } },
        itemStyle: { borderColor: t.surface, borderWidth: 2, borderRadius: 2 },
      },
    ],
  };
}

export function histogramOption(opt: EChartsOption, ax: ReturnType<typeof axisStyle>, h: { edges: number[]; counts: number[] }, name: string, dark: boolean): EChartsOption {
  const labels = h.counts.map((_, i) => `${fmtEdge(h.edges[i])}–${fmtEdge(h.edges[i + 1])}`);
  return {
    ...opt,
    grid: { left: 8, right: 16, top: 24, bottom: 8, containLabel: true },
    tooltip: { trigger: "axis", confine: true, axisPointer: { type: "shadow" } },
    xAxis: { type: "category", data: labels, name, ...ax, splitLine: { show: false } },
    yAxis: { type: "value", name: "count", ...ax },
    series: [{ type: "bar", name: "count", data: h.counts, barCategoryGap: "2%", itemStyle: { color: palette(dark)[0], borderRadius: [4, 4, 0, 0] } }],
  };
}

function treemapOption(opt: EChartsOption, data: { name: string; value?: number; children?: { name: string; value: number }[] }[], dark: boolean): EChartsOption {
  const t = ink(dark);
  return {
    ...opt,
    tooltip: { trigger: "item", confine: true, formatter: "{b}: {c}" },
    series: [
      {
        type: "treemap",
        data,
        roam: false,
        breadcrumb: { show: data.some((d) => d.children) },
        label: { color: "#ffffff" },
        itemStyle: { borderColor: t.surface, borderWidth: 2, gapWidth: 2 },
        levels: [{ itemStyle: { borderColor: t.surface, borderWidth: 2, gapWidth: 2 } }, { colorSaturation: [0.35, 0.6], itemStyle: { gapWidth: 1 } }],
      },
    ],
  };
}

export function gaugeOption(opt: EChartsOption, value: number, max: number, name: string, dark: boolean, bands?: [number, string][]): EChartsOption {
  const t = ink(dark);
  return {
    ...opt,
    series: [
      {
        type: "gauge",
        min: 0,
        max,
        progress: { show: true, width: 12, itemStyle: { color: palette(dark)[0] } },
        axisLine: { lineStyle: { width: 12, color: bands ?? [[1, t.grid]] } },
        axisTick: { show: false },
        splitLine: { show: false },
        axisLabel: { color: t.secondary, distance: 16 },
        pointer: { show: false },
        anchor: { show: false },
        title: { show: true, offsetCenter: [0, "70%"], color: t.secondary },
        detail: { valueAnimation: true, offsetCenter: [0, "10%"], fontSize: 28, color: t.primary, formatter: (v: number) => String(Number(v.toPrecision(4))) },
        data: [{ value, name }],
      },
    ],
  };
}

export function waterfallOption(opt: EChartsOption, ax: ReturnType<typeof axisStyle>, categories: string[], deltas: number[], dark: boolean, name = "value"): EChartsOption {
  const up = dark ? "#3987e5" : "#2a78d6";
  const down = dark ? "#e66767" : "#e34948";
  const total = dark ? "#8a8983" : "#52514e";
  const helper: (number | string)[] = [];
  const pos: (number | string)[] = [];
  const neg: (number | string)[] = [];
  let running = 0;
  for (const d of deltas) {
    const start = running;
    running += d;
    helper.push(Math.min(start, running));
    pos.push(d >= 0 ? d : "-");
    neg.push(d < 0 ? -d : "-");
  }
  const cats = [...categories, "Total"];
  helper.push(0);
  pos.push("-");
  neg.push("-");
  const totals: (number | string)[] = [...categories.map(() => "-"), running];
  return {
    ...opt,
    grid: { left: 8, right: 16, top: 36, bottom: 8, containLabel: true },
    legend: { show: true, top: 0, data: ["Increase", "Decrease", "Total"], textStyle: { color: ink(dark).secondary } },
    tooltip: {
      trigger: "axis",
      confine: true,
      axisPointer: { type: "shadow" },
      formatter: (params: unknown) => {
        const ps = params as { axisValue: string; seriesName: string; value: number | string }[];
        const shown = ps.filter((p) => p.seriesName !== "helper" && p.value !== "-");
        return `${ps[0]?.axisValue}<br/>${shown.map((p) => `${p.seriesName}: ${p.value}`).join("<br/>")}`;
      },
    },
    xAxis: { type: "category", data: cats, ...ax, splitLine: { show: false } },
    yAxis: { type: "value", name, ...ax },
    series: [
      { name: "helper", type: "bar", stack: "wf", itemStyle: { color: "transparent" }, emphasis: { disabled: true }, data: helper, tooltip: { show: false } },
      { name: "Increase", type: "bar", stack: "wf", data: pos, itemStyle: { color: up, borderRadius: 4 } },
      { name: "Decrease", type: "bar", stack: "wf", data: neg, itemStyle: { color: down, borderRadius: 4 } },
      { name: "Total", type: "bar", stack: "wf", data: totals, itemStyle: { color: total, borderRadius: 4 } },
    ],
  };
}

/** Simple line chart for x/y numeric arrays (ROC, PR, learning curves …). */
export function lineXY(
  series: { name: string; x: number[]; y: number[]; dashed?: boolean; area?: boolean }[],
  opts: { dark: boolean; xName: string; yName: string; xMax?: number; yMax?: number; diagonal?: boolean },
): EChartsOption {
  const ax = axisStyle(opts.dark);
  const t = ink(opts.dark);
  const all = [...series];
  const out: EChartsOption = {
    ...base(opts.dark),
    grid: { left: 8, right: 16, top: 36, bottom: 8, containLabel: true },
    legend: legend(opts.dark, all.length > 1),
    tooltip: { trigger: "axis", confine: true, valueFormatter: (v) => (typeof v === "number" ? String(Number(v.toPrecision(3))) : String(v)) },
    xAxis: { type: "value", name: opts.xName, nameLocation: "middle", nameGap: 24, max: opts.xMax, ...ax },
    yAxis: { type: "value", name: opts.yName, max: opts.yMax, scale: opts.yMax === undefined, ...ax },
    series: [
      ...all.map((s) => ({
        name: s.name,
        type: "line" as const,
        showSymbol: s.x.length < 30,
        symbolSize: 8,
        lineStyle: { width: 2, type: s.dashed ? ("dashed" as const) : ("solid" as const) },
        areaStyle: s.area ? { opacity: 0.12 } : undefined,
        data: s.x.map((xv, i) => [xv, s.y[i]]),
      })),
      ...(opts.diagonal
        ? [
            {
              name: "reference",
              type: "line" as const,
              data: [
                [0, 0],
                [1, 1],
              ],
              showSymbol: false,
              lineStyle: { width: 1, type: "dotted" as const, color: t.muted },
              tooltip: { show: false },
            },
          ]
        : []),
    ],
  };
  return out;
}

/** Horizontal bar chart of name/value pairs (feature importance, SHAP). */
export function barH(items: { name: string; value: number }[], opts: { dark: boolean; name: string; top?: number; signed?: boolean }): EChartsOption {
  const ax = axisStyle(opts.dark);
  const sorted = [...items].sort((a, b) => Math.abs(b.value) - Math.abs(a.value)).slice(0, opts.top ?? 20).reverse();
  const pal = palette(opts.dark);
  return {
    ...base(opts.dark),
    grid: { left: 8, right: 24, top: 8, bottom: 8, containLabel: true },
    tooltip: { trigger: "axis", confine: true, axisPointer: { type: "shadow" }, valueFormatter: (v) => (typeof v === "number" ? String(Number(v.toPrecision(4))) : String(v)) },
    xAxis: { type: "value", name: opts.name, ...ax },
    yAxis: { type: "category", data: sorted.map((i) => i.name), ...ax, splitLine: { show: false } },
    series: [
      {
        type: "bar",
        name: opts.name,
        barMaxWidth: 18,
        data: sorted.map((i) => ({
          value: i.value,
          itemStyle: { color: opts.signed && i.value < 0 ? (opts.dark ? "#e66767" : "#e34948") : pal[0], borderRadius: i.value < 0 ? [4, 0, 0, 4] : [0, 4, 4, 0] },
        })),
      },
    ],
  };
}

export function scatterXY(points: [number, number][], opts: { dark: boolean; xName: string; yName: string; zeroLine?: boolean }): EChartsOption {
  const ax = axisStyle(opts.dark);
  const t = ink(opts.dark);
  return {
    ...base(opts.dark),
    grid: { left: 8, right: 16, top: 24, bottom: 8, containLabel: true },
    tooltip: { trigger: "item", confine: true },
    xAxis: { type: "value", name: opts.xName, nameLocation: "middle", nameGap: 24, scale: true, ...ax },
    yAxis: { type: "value", name: opts.yName, scale: true, ...ax },
    dataZoom: [{ type: "inside", xAxisIndex: 0 }, { type: "inside", yAxisIndex: 0 }],
    series: [
      {
        type: "scatter",
        data: points,
        symbolSize: 8,
        itemStyle: { opacity: 0.7, color: palette(opts.dark)[0], borderColor: t.surface, borderWidth: 1 },
        markLine: opts.zeroLine ? { silent: true, symbol: "none", data: [{ yAxis: 0 }], lineStyle: { color: t.muted, type: "dashed" } } : undefined,
      },
    ],
  };
}

export function sparkline(values: number[], dark: boolean): EChartsOption {
  return {
    ...base(dark),
    grid: { left: 0, right: 0, top: 2, bottom: 2 },
    xAxis: { type: "category", show: false, data: values.map((_, i) => i) },
    yAxis: { type: "value", show: false, scale: true },
    tooltip: { show: false },
    series: [{ type: "line", data: values, showSymbol: false, lineStyle: { width: 2 }, areaStyle: { opacity: 0.12 } }],
  };
}

export { axisStyle, base as baseOption, ink };
