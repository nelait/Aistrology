import type { EChartsType } from "echarts/core";
import { saveBlob } from "@/lib/data";

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

/**
 * Compose a PNG of the visible dashboard page (DSH-009): each widget box with its title; charts are
 * drawn from ECharts `getDataURL`, other widgets from their text content.
 */
export async function exportDashboardPng(container: HTMLElement, charts: Map<string, EChartsType>, opts: { dark: boolean; filename: string }) {
  const scale = 2;
  const root = container.getBoundingClientRect();
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(root.width * scale);
  canvas.height = Math.ceil(root.height * scale);
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.scale(scale, scale);
  const bg = opts.dark ? "#232322" : "#f4f4f2";
  const surface = opts.dark ? "#1a1a19" : "#fcfcfb";
  const text = opts.dark ? "#ffffff" : "#0b0b0b";
  const text2 = opts.dark ? "#c3c2b7" : "#52514e";
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, root.width, root.height);

  const widgets = Array.from(container.querySelectorAll<HTMLElement>("[data-widget-id]"));
  for (const el of widgets) {
    const r = el.getBoundingClientRect();
    const x = r.left - root.left;
    const y = r.top - root.top;
    ctx.fillStyle = surface;
    ctx.strokeStyle = opts.dark ? "#383835" : "#e2e1dc";
    ctx.beginPath();
    ctx.roundRect(x, y, r.width, r.height, 8);
    ctx.fill();
    ctx.stroke();
    const title = el.getAttribute("aria-label") ?? "";
    ctx.fillStyle = text;
    ctx.font = "600 13px system-ui, sans-serif";
    ctx.fillText(title, x + 12, y + 20, r.width - 24);

    const id = el.dataset.widgetId!;
    const chart = charts.get(id);
    if (chart && !chart.isDisposed()) {
      const dom = chart.getDom().getBoundingClientRect();
      const img = await loadImage(chart.getDataURL({ type: "png", pixelRatio: scale, backgroundColor: surface }));
      ctx.drawImage(img, dom.left - root.left, dom.top - root.top, dom.width, dom.height);
    } else {
      const body = (el.querySelector("header + div") as HTMLElement | null)?.innerText ?? "";
      ctx.fillStyle = text2;
      ctx.font = "12px system-ui, sans-serif";
      body
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
        .slice(0, Math.max(1, Math.floor((r.height - 40) / 16)))
        .forEach((line, i) => ctx.fillText(line, x + 12, y + 44 + i * 16, r.width - 24));
    }
  }
  const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, "image/png"));
  if (blob) saveBlob(blob, opts.filename);
}
