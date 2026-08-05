import { Chart } from "../astro/types";
import { RASHIS } from "../astro/constants";
import { VARGA_BY_CODE, Varga } from "../astro/varga";
import { buildHouseCells, ascSignForVarga } from "./chartData";

interface Props {
  chart: Chart;
  mode: Varga;
}

// Fixed grid position (col,row) of each sign in the South Indian layout.
const SIGN_CELL: Record<number, { col: number; row: number }> = {
  0: { col: 1, row: 0 }, // Aries
  1: { col: 2, row: 0 }, // Taurus
  2: { col: 3, row: 0 }, // Gemini
  3: { col: 3, row: 1 }, // Cancer
  4: { col: 3, row: 2 }, // Leo
  5: { col: 3, row: 3 }, // Virgo
  6: { col: 2, row: 3 }, // Libra
  7: { col: 1, row: 3 }, // Scorpio
  8: { col: 0, row: 3 }, // Sagittarius
  9: { col: 0, row: 2 }, // Capricorn
  10: { col: 0, row: 1 }, // Aquarius
  11: { col: 0, row: 0 }, // Pisces
};

const CELL = 75;

export default function SouthChart({ chart, mode }: Props) {
  const cells = buildHouseCells(chart, mode);
  const ascSign = ascSignForVarga(chart, mode);
  // Map sign -> its cell data.
  const bySign = new Map(cells.map((c) => [c.signIndex, c]));

  return (
    <svg viewBox="0 0 300 300" className="kundli south" role="img" aria-label="South Indian chart">
      <rect x="1" y="1" width="298" height="298" className="frame" />
      {Object.entries(SIGN_CELL).map(([signStr, { col, row }]) => {
        const signIndex = Number(signStr);
        const x = col * CELL;
        const y = row * CELL;
        const cell = bySign.get(signIndex)!;
        const isAsc = signIndex === ascSign;
        const n = cell.planets.length;
        return (
          <g key={signIndex}>
            <rect x={x} y={y} width={CELL} height={CELL} className="cell" />
            {isAsc && (
              <line x1={x + 4} y1={y + 4} x2={x + 22} y2={y + 22} className="asc-mark" />
            )}
            <text className="sign-abbr" x={x + CELL - 5} y={y + 14}>
              {RASHIS[signIndex].name.slice(0, 3)}
            </text>
            {cell.planets.map((p, i) => {
              const perRow = 2;
              const cx = x + 8 + (i % perRow) * 34;
              const cy = y + 34 + Math.floor(i / perRow) * 18;
              return (
                <text key={p.name} className={`planet ${p.retro ? "retro" : ""}`} x={cx} y={cy}>
                  {p.short}
                  {p.retro ? "↺" : ""}
                </text>
              );
            })}
            {isAsc && <text className="asc-label" x={x + 5} y={y + CELL - 6}>ASC</text>}
          </g>
        );
      })}
      <text className="chart-center" x="150" y="150">
        {VARGA_BY_CODE[mode].name} {mode}
      </text>
    </svg>
  );
}
