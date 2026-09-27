"use client";
import ReactEChartsCore from "echarts-for-react/lib/core";
import type { EChartsOption } from "echarts";
import type { EChartsType } from "echarts/core";
import { echarts } from "./echarts";

export interface EChartProps {
  option: EChartsOption;
  height?: number | string;
  className?: string;
  onReady?: (chart: EChartsType) => void;
  onClick?: (params: { name?: string; seriesName?: string; value?: unknown; data?: unknown; dataIndex?: number }) => void;
  ariaLabel?: string;
}

export default function EChartImpl({ option, height = 300, className, onReady, onClick, ariaLabel }: EChartProps) {
  return (
    <div role="img" aria-label={ariaLabel ?? "Chart"} className={className} style={{ height, width: "100%" }}>
      <ReactEChartsCore
        echarts={echarts}
        option={{ aria: { enabled: true }, ...option }}
        notMerge
        lazyUpdate
        style={{ height: "100%", width: "100%" }}
        onChartReady={onReady}
        onEvents={onClick ? { click: onClick } : undefined}
        opts={{ renderer: "canvas" }}
      />
    </div>
  );
}
