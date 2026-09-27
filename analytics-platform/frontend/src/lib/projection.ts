/** 2-D projection scatter (FE-005a): colour points by a categorical or continuous value. */
import type { EChartsOption } from "echarts";
import { axisStyle, baseOption, ink, palette, SEQUENTIAL } from "./chartOptions";
import type { JsonValue } from "./types";

export const MAX_CATEGORIES = 12;

export type ColorScale = { kind: "none" } | { kind: "categorical"; categories: string[] } | { kind: "continuous"; min: number; max: number };

/** Categorical when there are few distinct values (or any non-numeric value), else a continuous scale. */
export function colorScale(values: JsonValue[] | null | undefined): ColorScale {
  if (!values?.length) return { kind: "none" };
  const present = values.filter((v) => v !== null && v !== undefined && v !== "");
  const distinct = [...new Set(present.map((v) => String(v)))];
  const numeric = present.length > 0 && present.every((v) => typeof v === "number" && Number.isFinite(v));
  if (numeric && distinct.length > MAX_CATEGORIES) {
    const nums = present as number[];
    return { kind: "continuous", min: Math.min(...nums), max: Math.max(...nums) };
  }
  const sorted = distinct.sort((a, b) => (numeric ? Number(a) - Number(b) : a.localeCompare(b)));
  const top = sorted.slice(0, MAX_CATEGORIES);
  const hasMissing = present.length < values.length;
  const hasOther = sorted.length > MAX_CATEGORIES;
  return { kind: "categorical", categories: [...top, ...(hasOther ? ["(other)"] : []), ...(hasMissing ? ["(missing)"] : [])] };
}

export function categoryOf(v: JsonValue | undefined, scale: Extract<ColorScale, { kind: "categorical" }>): string {
  if (v === null || v === undefined || v === "") return "(missing)";
  const s = String(v);
  return scale.categories.includes(s) ? s : "(other)";
}

export function projectionOption(x: number[], y: number[], color: JsonValue[] | null | undefined, opts: { dark: boolean; name: string; xName?: string; yName?: string }): EChartsOption {
  const ax = axisStyle(opts.dark);
  const t = ink(opts.dark);
  const pal = palette(opts.dark);
  const scale = colorScale(color);
  const common: EChartsOption = {
    ...baseOption(opts.dark),
    grid: { left: 8, right: scale.kind === "continuous" ? 70 : 16, top: scale.kind === "categorical" ? 40 : 16, bottom: 8, containLabel: true },
    tooltip: { trigger: "item", confine: true },
    xAxis: { type: "value", name: opts.xName ?? "dim 1", nameLocation: "middle", nameGap: 24, scale: true, ...ax },
    yAxis: { type: "value", name: opts.yName ?? "dim 2", scale: true, ...ax },
    dataZoom: [{ type: "inside", xAxisIndex: 0 }, { type: "inside", yAxisIndex: 0 }],
  };
  const symbolSize = x.length > 2000 ? 4 : x.length > 500 ? 5 : 7;
  if (scale.kind === "categorical") {
    return {
      ...common,
      legend: { show: true, top: 0, type: "scroll", textStyle: { color: t.secondary } },
      series: scale.categories.map((c, ci) => ({
        type: "scatter" as const,
        name: c,
        symbolSize,
        itemStyle: { color: c === "(missing)" || c === "(other)" ? t.muted : pal[ci % pal.length], opacity: 0.75 },
        data: x.map((xv, i) => (categoryOf(color?.[i], scale) === c ? [xv, y[i]] : null)).filter((d): d is [number, number] => d !== null),
      })),
    };
  }
  if (scale.kind === "continuous") {
    return {
      ...common,
      visualMap: { type: "continuous", min: scale.min, max: scale.max, dimension: 2, right: 0, top: "middle", calculable: true, inRange: { color: SEQUENTIAL }, text: [String(Number(scale.max.toPrecision(3))), String(Number(scale.min.toPrecision(3)))], textStyle: { color: t.secondary } },
      series: [{ type: "scatter", name: opts.name, symbolSize, itemStyle: { opacity: 0.8 }, data: x.map((xv, i) => [xv, y[i], color?.[i] as number]) }],
    };
  }
  return { ...common, series: [{ type: "scatter", name: opts.name, symbolSize, itemStyle: { color: pal[0], opacity: 0.7 }, data: x.map((xv, i) => [xv, y[i]]) }] };
}
