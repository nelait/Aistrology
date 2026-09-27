"use client";
import dynamic from "next/dynamic";
import type { EChartProps } from "./EChartImpl";

/** Client-only ECharts wrapper (echarts touches `window`). */
export const EChart = dynamic<EChartProps>(() => import("./EChartImpl"), {
  ssr: false,
  loading: () => <div className="h-full min-h-24 w-full animate-pulse rounded bg-[var(--surface-2)]" aria-hidden="true" />,
});

export type { EChartProps };
