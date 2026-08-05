import { useState } from "react";
import { computeChart } from "../astro/engine";
import { RASHIS } from "../astro/constants";
import type { BirthData, Chart, PlanetPosition } from "../astro/types";

// Five end-to-end worked examples: real birth data → a chart computed by the
// app's own engine → a six-step visual walkthrough of casting and reading it.
// Because the charts are computed (not hand-drawn), every claim stays true.

type Style = "north" | "south";

interface Example {
  id: string;
  persona: string;
  teaches: string;
  birth: BirthData;
  /** Which chart style the walkthrough opens in (both are always togglable). */
  defaultStyle?: Style;
  /** Persona-specific synthesis for the final step (grounded in the real chart). */
  reading: string;
}

const EXAMPLES: Example[] = [
  {
    id: "asha",
    persona: "Asha — noon in New Delhi",
    teaches: "The full five-step routine on a classic chart",
    birth: { name: "Asha", year: 1990, month: 1, day: 1, hour: 12, minute: 0, second: 0, tzOffsetHours: 5.5, latitude: 28.6139, longitude: 77.209, placeLabel: "New Delhi, India" },
    reading:
      "Pisces Lagna ruled by Jupiter, and Jupiter sits in house 4: life anchors around home, learning and inner development. The Sun and Saturn together in house 10 give a serious, duty-laden career; Mars in its own sign in house 9 energises fortune, conviction and travel. The Moon in house 12 keeps the mind private and reflective — a thoughtful person whose public duty (10th) is balanced by a rich inner world (4th, 12th).",
  },
  {
    id: "ravi",
    persona: "Ravi — sunrise in Chennai",
    teaches: "Sunrise births, and dignity extremes (exalted vs debilitated)",
    birth: { name: "Ravi", year: 1985, month: 6, day: 15, hour: 6, minute: 30, second: 0, tzOffsetHours: 5.5, latitude: 13.0827, longitude: 80.2707, placeLabel: "Chennai, India" },
    reading:
      "Born at sunrise, so the Sun stands in house 1 — sunrise births place the Sun with the Lagna. Better still, the Lagna lord Mercury is in its own sign right there in house 1: a visible, articulate self-starter. Saturn exalted in house 5 disciplines creativity into lasting work, while Jupiter debilitated in house 8 warns against shortcuts with other people's money. One chart, both extremes of dignity — always check the Dignity column.",
  },
  {
    id: "nina",
    persona: "Nina — the same instant, in New York",
    teaches: "Place changes the chart: same sky, different Lagna",
    birth: { name: "Nina", year: 1990, month: 1, day: 1, hour: 1, minute: 30, second: 0, tzOffsetHours: -5, latitude: 40.7128, longitude: -74.006, placeLabel: "New York, USA" },
    reading:
      "Nina was born at the very same instant as Asha — Delhi noon is New York 1:30 AM. Compare the two charts: every planet keeps its sign (the sky is the sky), but the Lagna is Libra instead of Pisces, so every house renumbers. Asha's 10th-house Sun is Nina's 3rd-house Sun; a career signature becomes a courage-and-communication signature. Place doesn't move the planets — it moves the frame you view them through.",
  },
  {
    id: "dusk",
    persona: "Asha's evening twin — Delhi, 18:00",
    teaches: "Time changes the Lagna: six hours = three signs",
    birth: { name: "Dusk twin", year: 1990, month: 1, day: 1, hour: 18, minute: 0, second: 0, tzOffsetHours: 5.5, latitude: 28.6139, longitude: 77.209, placeLabel: "New Delhi, India" },
    reading:
      "Same day, same city as Asha — but six hours later. The Lagna moves one sign roughly every two hours, so it has advanced three signs: Pisces → Gemini. Jupiter, which sat quietly in Asha's house 4, now rises in house 1 and defines the personality; the Sun–Saturn pair drops from the career house into house 7, shifting the life's weight from profession to partnership. This is why an accurate birth time matters more than anything else.",
  },
  {
    id: "meera",
    persona: "Meera — morning in Delhi, 2011",
    teaches: "Reading a subtle chart: a hidden Lagna lord",
    birth: { name: "Meera", year: 2011, month: 8, day: 15, hour: 7, minute: 0, second: 0, tzOffsetHours: 5.5, latitude: 28.6139, longitude: 77.209, placeLabel: "New Delhi, India" },
    reading:
      "Leo Lagna — but its lord the Sun sits in house 12: leadership expressed behind the scenes, in service, research or institutions rather than on stage. Mercury retrograde in house 1 gives a mind that re-processes and refines its self-image. The Moon in house 7 orients the emotions toward partners and the public. Not every chart shouts; this one teaches you to read quiet placements honestly.",
  },
  {
    id: "kiran",
    persona: "Kiran — sunrise in Hyderabad (South style)",
    teaches: "Reading a South Indian chart: find the stroke, count clockwise",
    birth: { name: "Kiran", year: 1996, month: 4, day: 14, hour: 5, minute: 45, second: 0, tzOffsetHours: 5.5, latitude: 17.385, longitude: 78.4867, placeLabel: "Hyderabad, India" },
    defaultStyle: "south",
    reading:
      "In the South grid the signs never move, so read by box. The Lagna stroke sits in Pisces, and three planets share that box — Mars, Saturn and Ketu — a heavily tenanted house 1: a serious, resilient, self-reliant nature that carries weight early. Count clockwise: the next box, Aries, holds an exalted Sun with Mercury in house 2 — strong voice, strong earning power. Jupiter in its own sign Sagittarius lands in house 10 (career, dharma), and Venus in its own sign Taurus in house 3. Two own-sign planets plus an exalted Sun make this a genuinely strong chart.",
  },
  {
    id: "lakshmi",
    persona: "Lakshmi — morning in Madurai (South style)",
    teaches: "Sign clusters: two planets, one box, opposite dignities",
    birth: { name: "Lakshmi", year: 2000, month: 9, day: 5, hour: 8, minute: 30, second: 0, tzOffsetHours: 5.5, latitude: 9.9252, longitude: 78.1198, placeLabel: "Madurai, India" },
    defaultStyle: "south",
    reading:
      "This chart shows why the fixed-sign grid is so useful. Virgo is the Lagna, and its box holds a striking pair: Mercury exalted and Venus debilitated — the same sign lifting one planet and sinking the other, because dignity depends on which planet meets which sign. A sharp, analytical mind (exalted Mercury on the Lagna) alongside a fussier, more self-critical relationship to comfort and affection (fallen Venus). Add a debilitated Moon in house 3 and Mars fallen in house 11, and you get a chart that rewards discernment over ease — the Mercury is the asset to build on.",
  },
];

// ── North-chart geometry (300×300) ─────────────────────────────────────────
const P = { A: "2,2", B: "298,2", C: "298,298", D: "2,298", T: "150,2", R: "298,150", Bo: "150,298", L: "2,150", O: "150,150", TL: "76,76", TR: "224,76", BR: "224,224", BL: "76,224" };
const HOUSE_POLYS: string[] = [
  `${P.T} ${P.TR} ${P.O} ${P.TL}`,      // 1
  `${P.A} ${P.T} ${P.TL}`,              // 2
  `${P.A} ${P.TL} ${P.L}`,              // 3
  `${P.L} ${P.TL} ${P.O} ${P.BL}`,      // 4
  `${P.D} ${P.L} ${P.BL}`,              // 5
  `${P.D} ${P.BL} ${P.Bo}`,             // 6
  `${P.Bo} ${P.BL} ${P.O} ${P.BR}`,     // 7
  `${P.C} ${P.Bo} ${P.BR}`,             // 8
  `${P.C} ${P.BR} ${P.R}`,              // 9
  `${P.R} ${P.BR} ${P.O} ${P.TR}`,      // 10
  `${P.B} ${P.R} ${P.TR}`,              // 11
  `${P.B} ${P.TR} ${P.T}`,              // 12
];
const HOUSE_ANCHORS: [number, number][] = [
  [150, 84], [75, 34], [36, 84], [70, 150], [36, 218], [75, 268],
  [150, 220], [225, 268], [264, 218], [230, 150], [264, 84], [225, 34],
];
const ABBR: Record<string, string> = {
  Sun: "Su", Moon: "Mo", Mars: "Ma", Mercury: "Me", Jupiter: "Ju",
  Venus: "Ve", Saturn: "Sa", Rahu: "Ra", Ketu: "Ke",
};
const HOUSE_THEME = [
  "self and body", "wealth and speech", "courage and siblings", "home and heart",
  "creativity and children", "work and health", "partnership", "depth and change",
  "fortune and dharma", "career and status", "gains and friends", "retreat and release",
];

function dignityClass(p: PlanetPosition): string {
  if (p.dignity === "Exalted") return "exalted";
  if (p.dignity === "Debilitated") return "debilitated";
  if (p.dignity === "Own sign" || p.dignity === "Moolatrikona") return "own";
  return "";
}

function ExampleKundli({ chart, hlHouses = [], hlPlanets = [], showDignity = false }: {
  chart: Chart; hlHouses?: number[]; hlPlanets?: string[]; showDignity?: boolean;
}) {
  const byHouse = new Map<number, PlanetPosition[]>();
  for (const p of chart.planets) {
    byHouse.set(p.house, [...(byHouse.get(p.house) ?? []), p]);
  }
  const dimming = hlHouses.length > 0 || hlPlanets.length > 0;
  return (
    <svg viewBox="0 0 300 300" className="ex-kundli" role="img" aria-label="Example chart">
      <rect x="2" y="2" width="296" height="296" rx="6" className="lv-frame" />
      {hlHouses.map((h) => <polygon key={h} points={HOUSE_POLYS[h - 1]} className="lv-hl-gold" />)}
      <line x1="2" y1="2" x2="298" y2="298" className="lv-line" />
      <line x1="298" y1="2" x2="2" y2="298" className="lv-line" />
      <polygon points={`${P.T} ${P.R} ${P.Bo} ${P.L}`} className="lv-line lv-nofill" />
      {HOUSE_ANCHORS.map(([x, y], i) => {
        const house = i + 1;
        const sign = chart.houseSigns[i] + 1;
        const planets = byHouse.get(house) ?? [];
        const rows: PlanetPosition[][] = [];
        for (let j = 0; j < planets.length; j += 2) rows.push(planets.slice(j, j + 2));
        const hlHouse = hlHouses.includes(house);
        return (
          <g key={house} className={dimming && !hlHouse ? "ex-house dim" : "ex-house"}>
            <text x={x} y={y - 12} className={`ex-sign${hlHouse ? " gold" : ""}`}>{sign}</text>
            {rows.map((row, r) => (
              <text key={r} x={x} y={y + 4 + r * 14} className="ex-planets">
                {row.map((p) => {
                  const hl = hlPlanets.includes(p.planet);
                  const cls = `ex-pl${hl ? " hl" : ""}${showDignity ? ` ${dignityClass(p)}` : ""}`;
                  return (
                    <tspan key={p.planet} className={cls}>
                      {ABBR[p.planet]}{p.retrograde ? "*" : ""}{" "}
                    </tspan>
                  );
                })}
              </text>
            ))}
          </g>
        );
      })}
    </svg>
  );
}

// ── South-chart geometry: signs are FIXED boxes, zodiac runs clockwise ─────
// [col, row] on a 4×4 grid, indexed by sign (0 = Aries … 11 = Pisces).
const SOUTH_POS: [number, number][] = [
  [1, 0], [2, 0], [3, 0], [3, 1], [3, 2], [3, 3],
  [2, 3], [1, 3], [0, 3], [0, 2], [0, 1], [0, 0],
];
const SIGN_ABBR = ["Ari", "Tau", "Gem", "Can", "Leo", "Vir", "Lib", "Sco", "Sag", "Cap", "Aqu", "Pis"];

function ExampleKundliSouth({ chart, hlHouses = [], hlPlanets = [], showDignity = false }: {
  chart: Chart; hlHouses?: number[]; hlPlanets?: string[]; showDignity?: boolean;
}) {
  const CW = 75, CH = 62, PAD = 2;
  const bySign = new Map<number, PlanetPosition[]>();
  for (const p of chart.planets) bySign.set(p.signIndex, [...(bySign.get(p.signIndex) ?? []), p]);
  const dimming = hlHouses.length > 0 || hlPlanets.length > 0;

  return (
    <svg viewBox="0 0 304 252" className="ex-kundli" role="img" aria-label="Example chart, South Indian style">
      {SOUTH_POS.map(([col, row], sign) => {
        // Whole-sign houses: house = distance from the ascendant's sign.
        const house = ((sign - chart.ascendantSign + 12) % 12) + 1;
        const x = PAD + col * CW, y = PAD + row * CH;
        const planets = bySign.get(sign) ?? [];
        const hlHouse = hlHouses.includes(house);
        const isLagna = house === 1;
        const rows: PlanetPosition[][] = [];
        for (let j = 0; j < planets.length; j += 2) rows.push(planets.slice(j, j + 2));
        return (
          <g key={sign} className={dimming && !hlHouse ? "ex-house dim" : "ex-house"}>
            <rect x={x} y={y} width={CW} height={CH} className={`lv-frame${hlHouse ? " gold" : ""}`} />
            {hlHouse && <rect x={x} y={y} width={CW} height={CH} className="ex-south-hl" />}
            {/* The classical Lagna marker: a diagonal stroke in the rising sign. */}
            {isLagna && <line x1={x + 3} y1={y + 17} x2={x + 21} y2={y + 3} className="lv-lagna-stroke" />}
            <text x={x + CW - 5} y={y + 13} className={`ex-south-sign${hlHouse ? " gold" : ""}`}>{SIGN_ABBR[sign]}</text>
            <text x={x + 6} y={y + CH - 6} className="ex-south-house">{house}</text>
            {rows.map((r, i) => (
              <text key={i} x={x + CW / 2} y={y + 30 + i * 13} className="ex-planets">
                {r.map((p) => (
                  <tspan key={p.planet} className={`ex-pl${hlPlanets.includes(p.planet) ? " hl" : ""}${showDignity ? ` ${dignityClass(p)}` : ""}`}>
                    {ABBR[p.planet]}{p.retrograde ? "*" : ""}{" "}
                  </tspan>
                ))}
              </text>
            ))}
          </g>
        );
      })}
      <text x="152" y="112" className="lv-tag">signs fixed · houses</text>
      <text x="152" y="128" className="lv-tag">count clockwise ↻</text>
      <text x="152" y="146" className="lv-tag small gold">◢ = Lagna</text>
    </svg>
  );
}

interface Step { title: string; text: string; hlHouses?: number[]; hlPlanets?: string[]; showDignity?: boolean; showChart: boolean; }

function buildSteps(ex: Example, chart: Chart, style: Style): Step[] {
  const asc = RASHIS[chart.ascendantSign];
  const lord = chart.planets.find((p) => p.planet === asc.lord)!;
  const moon = chart.planets.find((p) => p.planet === "Moon")!;
  const standouts = chart.planets.filter((p) => p.dignity !== "Neutral");
  const b = ex.birth;
  const time = `${String(b.hour).padStart(2, "0")}:${String(b.minute).padStart(2, "0")}`;
  return [
    {
      title: "① The birth details",
      showChart: false,
      text:
        `${ex.persona.split("—")[0].trim()} was born on ${String(b.day).padStart(2, "0")}/${String(b.month).padStart(2, "0")}/${b.year} at ${time} in ${b.placeLabel} (UTC${b.tzOffsetHours >= 0 ? "+" : ""}${b.tzOffsetHours}). ` +
        "Three details aim the camera: the date fixes the planets, the exact time fixes the rising sign, and the place fixes the horizon.",
    },
    {
      title: "② The cast chart",
      showChart: true,
      text: style === "south"
        ? "The engine computes sidereal positions and draws the Kundli. In the South Indian grid the SIGNS are fixed boxes (Aries top-left-of-centre, running clockwise); " +
          "the corner label is the sign, the small number is its house for this chart, and the letters are planets (* = retrograde)."
        : "The engine computes sidereal positions and draws the Kundli (North style: houses fixed, counted anti-clockwise from the top diamond). " +
          "The small number in each house is its sign (1 = Aries … 12 = Pisces); the letters are planets (* = retrograde).",
    },
    {
      title: "③ Find the Lagna",
      showChart: true,
      hlHouses: [1],
      text: style === "south"
        ? `Look for the diagonal stroke ◢ — it marks the rising sign, here ${asc.name} (a ${asc.element.toLowerCase()} sign ruled by ${asc.lord}). ` +
          `That box is house 1; every other house is counted clockwise from it. This ${asc.name} Lagna is the chart's frame: body, temperament and direction of life.`
        : `House 1 holds sign ${chart.ascendantSign + 1} — ${asc.name}, a ${asc.element.toLowerCase()} sign ruled by ${asc.lord}. ` +
          `This ${asc.name} Lagna is the chart's frame: the body, temperament and general direction of life.`,
    },
    {
      title: "④ Follow the Lagna lord",
      showChart: true,
      hlHouses: [lord.house],
      hlPlanets: [lord.planet],
      text:
        `${asc.name}'s ruler is ${lord.planet}, and it sits in house ${lord.house} (${RASHIS[lord.signIndex].name}${lord.retrograde ? ", retrograde" : ""}). ` +
        `The Lagna lord carries the person's core energy into that arena — here, ${HOUSE_THEME[lord.house - 1]}.`,
    },
    {
      title: "⑤ The Moon & the standouts",
      showChart: true,
      hlPlanets: [ "Moon", ...standouts.map((p) => p.planet) ],
      showDignity: true,
      text:
        `The Moon — the mind — is in ${RASHIS[moon.signIndex].name}, house ${moon.house} (${HOUSE_THEME[moon.house - 1]}). ` +
        (standouts.length
          ? `Dignity standouts: ${standouts.map((p) => `${p.planet} ${p.dignity.toLowerCase()} in house ${p.house}`).join("; ")}. Strong planets deliver confidently; debilitated ones need support.`
          : "No planet is exalted, debilitated or in its own sign here — a chart of moderate dignities, where houses and the dasha decide."),
    },
    {
      title: "⑥ The reading",
      showChart: true,
      text: ex.reading,
    },
  ];
}

export default function LessonExamples() {
  const [openId, setOpenId] = useState<string | null>(null);
  const [step, setStep] = useState(0);
  const [style, setStyle] = useState<Style>("north");

  const example = openId ? EXAMPLES.find((e) => e.id === openId) ?? null : null;
  if (!example) {
    return (
      <div className="lessons-list">
        <p className="muted small lessons-intro">
          Five real charts, computed by the app's engine, each read end-to-end in six short steps.
        </p>
        {EXAMPLES.map((e, i) => {
          const asc = RASHIS[computeChart(e.birth).ascendantSign].name;
          return (
            <button
              key={e.id}
              className="lessons-item"
              onClick={() => { setOpenId(e.id); setStep(0); setStyle(e.defaultStyle ?? "north"); }}
            >
              <span className="ex-num">{i + 1}</span>
              <span className="lessons-item-text">
                <span className="lessons-item-title">{e.persona}</span>
                <span className="muted small">{e.teaches}</span>
              </span>
              <span className="lessons-item-meta">
                <span className="level beginner">{asc} Lagna</span>
                <span className="muted small">{e.defaultStyle === "south" ? "South · 6 steps" : "6 steps"}</span>
              </span>
            </button>
          );
        })}
      </div>
    );
  }

  const chart = computeChart(example.birth);
  const steps = buildSteps(example, chart, style);
  const s = steps[step];
  const Kundli = style === "south" ? ExampleKundliSouth : ExampleKundli;

  return (
    <div className="lessons-reader">
      <div className="lessons-reader-body">
        <button className="link lessons-back" onClick={() => setOpenId(null)}>← All examples</button>
        <h3 className="ex-title">{example.persona}</h3>
        <div className="ex-dots" role="tablist" aria-label="Steps">
          {steps.map((st, i) => (
            <button
              key={i} role="tab" aria-selected={i === step}
              className={`ex-dot${i === step ? " on" : ""}${i < step ? " past" : ""}`}
              onClick={() => setStep(i)}
              title={st.title}
            />
          ))}
        </div>
        <h4 className="ex-step-title">{s.title}</h4>
        {s.showChart && (
          <div className="ex-style-toggle" role="group" aria-label="Chart style">
            <button className={style === "north" ? "on" : ""} onClick={() => setStyle("north")}>North Indian</button>
            <button className={style === "south" ? "on" : ""} onClick={() => setStyle("south")}>South Indian</button>
          </div>
        )}
        {s.showChart ? (
          <Kundli chart={chart} hlHouses={s.hlHouses} hlPlanets={s.hlPlanets} showDignity={s.showDignity} />
        ) : (
          <div className="ex-birth-card">
            <span className="lv-chip">📅 {String(example.birth.day).padStart(2, "0")}/{String(example.birth.month).padStart(2, "0")}/{example.birth.year}</span>
            <span className="lv-chip">⏰ {String(example.birth.hour).padStart(2, "0")}:{String(example.birth.minute).padStart(2, "0")}</span>
            <span className="lv-chip">📍 {example.birth.placeLabel}</span>
          </div>
        )}
        <p className="ex-step-text">{s.text}</p>
        {step === 1 && <p className="muted small">* = retrograde. Numbers are signs; house 1 is the top diamond.</p>}
      </div>
      <footer className="lessons-reader-foot">
        <button className="mini-btn" disabled={step === 0} onClick={() => setStep((v) => Math.max(0, v - 1))}>← Prev</button>
        <span className="muted small">Step {step + 1} / {steps.length}</span>
        {step < steps.length - 1 ? (
          <button className="mini-btn ok" onClick={() => setStep((v) => v + 1)}>Next →</button>
        ) : (
          <button className="mini-btn ok" onClick={() => setOpenId(null)}>Done ✓</button>
        )}
      </footer>
    </div>
  );
}
