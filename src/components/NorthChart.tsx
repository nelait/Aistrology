import { Chart } from "../astro/types";
import { RASHIS } from "../astro/constants";
import { Varga } from "../astro/varga";
import { buildHouseCells } from "./chartData";

interface Props {
  chart: Chart;
  mode: Varga;
}

// Label centroids for the 12 houses in a 300x300 North Indian (diamond) chart.
const HOUSE_POS: Record<number, { x: number; y: number }> = {
  1: { x: 150, y: 72 },
  2: { x: 75, y: 30 },
  3: { x: 28, y: 78 },
  4: { x: 78, y: 150 },
  5: { x: 28, y: 222 },
  6: { x: 75, y: 270 },
  7: { x: 150, y: 228 },
  8: { x: 225, y: 270 },
  9: { x: 272, y: 222 },
  10: { x: 222, y: 150 },
  11: { x: 272, y: 78 },
  12: { x: 225, y: 30 },
};

// Where the small sign number sits within each house (nudged toward the rim).
const SIGN_POS: Record<number, { x: number; y: number }> = {
  1: { x: 150, y: 40 },
  2: { x: 55, y: 18 },
  3: { x: 16, y: 55 },
  4: { x: 42, y: 150 },
  5: { x: 16, y: 245 },
  6: { x: 55, y: 285 },
  7: { x: 150, y: 262 },
  8: { x: 245, y: 285 },
  9: { x: 284, y: 245 },
  10: { x: 258, y: 150 },
  11: { x: 284, y: 55 },
  12: { x: 245, y: 18 },
};

export default function NorthChart({ chart, mode }: Props) {
  const cells = buildHouseCells(chart, mode);

  return (
    <svg viewBox="0 0 300 300" className="kundli north" role="img" aria-label="North Indian chart">
      <rect x="1" y="1" width="298" height="298" className="frame" />
      {/* diagonals */}
      <line x1="1" y1="1" x2="299" y2="299" className="grid" />
      <line x1="299" y1="1" x2="1" y2="299" className="grid" />
      {/* inner diamond */}
      <polygon points="150,1 299,150 150,299 1,150" className="grid diamond" />

      {cells.map((cell) => {
        const pos = HOUSE_POS[cell.house];
        const signPos = SIGN_POS[cell.house];
        const n = cell.planets.length;
        return (
          <g key={cell.house}>
            <text className="sign-num" x={signPos.x} y={signPos.y}>
              {cell.signIndex + 1}
            </text>
            {cell.planets.map((p, i) => {
              // lay planets out in up to two short rows around the centroid
              const perRow = n > 3 ? 3 : n;
              const row = Math.floor(i / perRow);
              const col = i % perRow;
              const rows = Math.ceil(n / perRow);
              const dx = (col - (Math.min(perRow, n - row * perRow) - 1) / 2) * 24;
              const dy = (row - (rows - 1) / 2) * 20;
              return (
                <text
                  key={p.name}
                  className={`planet ${p.retro ? "retro" : ""}`}
                  x={pos.x + dx}
                  y={pos.y + dy}
                >
                  {p.short}
                  {p.retro ? "↺" : ""}
                </text>
              );
            })}
          </g>
        );
      })}
    </svg>
  );
}

export function SignLegend() {
  return (
    <div className="sign-legend">
      {RASHIS.map((r) => (
        <span key={r.index}>
          <b>{r.index + 1}</b> {r.name}
        </span>
      ))}
    </div>
  );
}
