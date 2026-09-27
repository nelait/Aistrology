/** Tree-shaken ECharts build with every chart type the platform uses (VIZ-001, VIZ-001a). */
import * as echarts from "echarts/core";
import { BarChart, BoxplotChart, FunnelChart, GaugeChart, HeatmapChart, LineChart, PieChart, SankeyChart, ScatterChart, TreemapChart } from "echarts/charts";
import {
  AriaComponent,
  DataZoomComponent,
  GridComponent,
  LegendComponent,
  MarkLineComponent,
  TitleComponent,
  ToolboxComponent,
  TooltipComponent,
  VisualMapComponent,
} from "echarts/components";
import { CanvasRenderer, SVGRenderer } from "echarts/renderers";

echarts.use([
  BarChart,
  BoxplotChart,
  FunnelChart,
  GaugeChart,
  HeatmapChart,
  LineChart,
  PieChart,
  SankeyChart,
  ScatterChart,
  TreemapChart,
  AriaComponent,
  DataZoomComponent,
  GridComponent,
  LegendComponent,
  MarkLineComponent,
  TitleComponent,
  ToolboxComponent,
  TooltipComponent,
  VisualMapComponent,
  CanvasRenderer,
  SVGRenderer,
]);

export { echarts };

/** Render an option off-screen with the SVG renderer and return the SVG markup (VIZ-004). */
export function renderSvg(option: echarts.EChartsCoreOption, width: number, height: number): string {
  const el = document.createElement("div");
  const chart = echarts.init(el, undefined, { renderer: "svg", ssr: true, width, height });
  chart.setOption({ ...option, animation: false });
  const svg = chart.renderToSVGString();
  chart.dispose();
  return svg;
}
