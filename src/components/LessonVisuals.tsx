// Small, self-contained diagrams for the lessons (see data/lessons.ts →
// LessonSection.visual). Pure SVG/HTML, themed via CSS classes in styles.css.

const NORTH_HOUSES: [number, number, number][] = [
  // [house, x, y] on a 300×300 diamond — house 1 is always the top-centre diamond.
  [1, 150, 82], [2, 75, 42], [3, 40, 82], [4, 78, 152], [5, 40, 225], [6, 75, 265],
  [7, 150, 228], [8, 225, 265], [9, 260, 225], [10, 222, 152], [11, 260, 82], [12, 225, 42],
];

/** The North Indian diamond frame (outer square + diagonals + midpoint diamond). */
function NorthFrame() {
  return (
    <>
      <rect x="2" y="2" width="296" height="296" rx="6" className="lv-frame" />
      <line x1="2" y1="2" x2="298" y2="298" className="lv-line" />
      <line x1="298" y1="2" x2="2" y2="298" className="lv-line" />
      <polygon points="150,2 298,150 150,298 2,150" className="lv-line lv-nofill" />
    </>
  );
}

function NorthLayout() {
  return (
    <figure className="lesson-visual">
      <svg viewBox="0 0 300 300" role="img" aria-label="North Indian chart layout with fixed house positions">
        <NorthFrame />
        <polygon points="150,2 224,76 150,150 76,76" className="lv-hl-gold" />
        {NORTH_HOUSES.map(([h, x, y]) => (
          <text key={h} x={x} y={y} className={`lv-num${h === 1 ? " gold" : ""}`}>{h}</text>
        ))}
        <text x="150" y="112" className="lv-tag gold">Lagna</text>
        {/* Anti-clockwise reading order hint */}
        <path d="M 150 34 A 116 116 0 0 0 44 150" className="lv-arrow" markerEnd="url(#lvArrow)" />
        <defs>
          <marker id="lvArrow" viewBox="0 0 8 8" refX="6" refY="4" markerWidth="7" markerHeight="7" orient="auto">
            <path d="M 0 0 L 8 4 L 0 8 z" className="lv-arrow-head" />
          </marker>
        </defs>
      </svg>
      <figcaption>
        North Indian: <strong>houses are fixed</strong> — house 1 (Lagna) is always the top diamond;
        count houses anti-clockwise. The number written in a house is its sign.
      </figcaption>
    </figure>
  );
}

const SOUTH_CELLS: { sign: string; col: number; row: number; aries?: boolean; lagna?: boolean }[] = [
  { sign: "Pisces", col: 0, row: 0 }, { sign: "Aries", col: 1, row: 0, aries: true },
  { sign: "Taurus", col: 2, row: 0 }, { sign: "Gemini", col: 3, row: 0 },
  { sign: "Aquarius", col: 0, row: 1 }, { sign: "Cancer", col: 3, row: 1 },
  { sign: "Capricorn", col: 0, row: 2 }, { sign: "Leo", col: 3, row: 2, lagna: true },
  { sign: "Sagittarius", col: 0, row: 3 }, { sign: "Scorpio", col: 1, row: 3 },
  { sign: "Libra", col: 2, row: 3 }, { sign: "Virgo", col: 3, row: 3 },
];

function SouthLayout() {
  const W = 85, H = 66;
  return (
    <figure className="lesson-visual">
      <svg viewBox="0 0 344 268" role="img" aria-label="South Indian chart layout with fixed sign positions">
        {SOUTH_CELLS.map((c) => {
          const x = 2 + c.col * W, y = 2 + c.row * H;
          return (
            <g key={c.sign}>
              <rect x={x} y={y} width={W} height={H} className={`lv-frame${c.aries ? " gold" : ""}`} />
              {c.lagna && <line x1={x + 3} y1={y + 16} x2={x + 20} y2={y + 3} className="lv-lagna-stroke" />}
              <text x={x + W / 2} y={y + H / 2 + 4} className={`lv-cell${c.aries ? " gold" : ""}`}>{c.sign}</text>
            </g>
          );
        })}
        <text x="172" y="120" className="lv-tag">Signs are fixed</text>
        <text x="172" y="140" className="lv-tag muted">zodiac runs clockwise ↻</text>
        <text x="172" y="162" className="lv-tag small">◢ stroke = Lagna (here: Leo)</text>
      </svg>
      <figcaption>
        South Indian: <strong>signs are fixed</strong> — Aries always sits in the same box (highlighted).
        The diagonal stroke marks the rising sign; count houses clockwise from it.
      </figcaption>
    </figure>
  );
}

function ReadExample() {
  return (
    <figure className="lesson-visual">
      <svg viewBox="0 0 300 300" role="img" aria-label="Example: Leo Lagna with the Sun in house 10">
        <NorthFrame />
        <polygon points="150,2 224,76 150,150 76,76" className="lv-hl-gold" />
        <polygon points="150,150 224,76 298,150 224,224" className="lv-hl-accent" />
        {NORTH_HOUSES.map(([h, x, y]) => {
          if (h === 1 || h === 10) return null;
          return <text key={h} x={x} y={y} className="lv-num dim">{h}</text>;
        })}
        <text x="150" y="70" className="lv-step gold">①</text>
        <text x="150" y="95" className="lv-num gold">5</text>
        <text x="150" y="115" className="lv-tag gold">Leo Lagna</text>
        <text x="222" y="120" className="lv-step accent">②</text>
        <text x="222" y="146" className="lv-num accent">Su</text>
        <text x="222" y="166" className="lv-tag accent">house 10</text>
      </svg>
      <figcaption>
        Worked example: ① house 1 shows sign 5 → <strong>Leo Lagna</strong>; its lord the Sun sits in
        ② <strong>house 10</strong> — life's energy flows to career and public standing.
      </figcaption>
    </figure>
  );
}

function CastFlow() {
  return (
    <figure className="lesson-visual">
      <div className="lv-flow">
        <div className="lv-flow-inputs">
          <span className="lv-chip">📅 Date</span>
          <span className="lv-chip">⏰ Exact time</span>
          <span className="lv-chip">📍 Place</span>
        </div>
        <span className="lv-flow-arrow">→</span>
        <div className="lv-flow-node">🌌 Sky at that moment<span className="muted small">planet positions + rising sign</span></div>
        <span className="lv-flow-arrow">→</span>
        <div className="lv-flow-node">🗺️ Your Kundli<span className="muted small">signs · houses · nakshatras</span></div>
      </div>
      <figcaption>
        Date fixes the planets, time fixes the Lagna, place fixes the horizon — together they aim the
        camera that photographs the sky.
      </figcaption>
    </figure>
  );
}

function VargaSplit() {
  const slices = Array.from({ length: 9 }, (_, i) => i);
  return (
    <figure className="lesson-visual">
      <svg viewBox="0 0 320 150" role="img" aria-label="One sign of 30 degrees divided into nine navamsa slices">
        {/* D1: one sign as a 30° bar */}
        <rect x="10" y="18" width="300" height="34" className="lv-frame" />
        <text x="160" y="12" className="lv-tag">one sign in the D1 — 30°</text>
        <text x="160" y="40" className="lv-num gold">Aries</text>
        {/* split arrows */}
        <line x1="160" y1="56" x2="160" y2="76" className="lv-arrow" markerEnd="url(#lvArrow2)" />
        <defs>
          <marker id="lvArrow2" viewBox="0 0 8 8" refX="6" refY="4" markerWidth="7" markerHeight="7" orient="auto">
            <path d="M 0 0 L 8 4 L 0 8 z" className="lv-arrow-head" />
          </marker>
        </defs>
        {/* D9: nine slices */}
        {slices.map((i) => (
          <g key={i}>
            <rect x={10 + i * 33.4} y={82} width={33.4} height={34} className={`lv-frame${i === 5 ? " gold" : ""}`} />
            <text x={10 + i * 33.4 + 16.7} y={103} className={`lv-cell${i === 5 ? " gold" : ""}`}>{i + 1}</text>
          </g>
        ))}
        <text x="160" y="132" className="lv-tag">nine navamsas — 3°20&apos; each</text>
        <text x="160" y="146" className="lv-tag small gold">a planet at 17° falls in slice 6 → its D9 sign</text>
      </svg>
      <figcaption>
        The Navamsa (D9) divides every sign into nine parts of 3°20&apos;. Each part becomes a full
        sign in the D9 — so the same planet can tell a second, finer story.
      </figcaption>
    </figure>
  );
}

function SadeSati() {
  const boxes = [
    { x: 15, label: "12th from Moon", sub: "Phase 1", moon: false },
    { x: 115, label: "Moon sign", sub: "Phase 2 — peak", moon: true },
    { x: 215, label: "2nd from Moon", sub: "Phase 3", moon: false },
  ];
  return (
    <figure className="lesson-visual">
      <svg viewBox="0 0 320 140" role="img" aria-label="Saturn crossing the 12th, 1st and 2nd signs from the natal Moon">
        {/* Saturn's path */}
        <path d="M 30 30 H 290" className="lv-arrow" markerEnd="url(#lvArrow3)" />
        <defs>
          <marker id="lvArrow3" viewBox="0 0 8 8" refX="6" refY="4" markerWidth="7" markerHeight="7" orient="auto">
            <path d="M 0 0 L 8 4 L 0 8 z" className="lv-arrow-head" />
          </marker>
        </defs>
        <text x="160" y="20" className="lv-tag accent">♄ Saturn — ~2.5 years per sign</text>
        {boxes.map((b) => (
          <g key={b.label}>
            <rect x={b.x} y={45} width={90} height={58} className={`lv-frame${b.moon ? " gold" : ""}`} />
            {b.moon && <text x={b.x + 45} y={70} className="lv-num gold">🌙</text>}
            <text x={b.x + 45} y={b.moon ? 88 : 72} className="lv-cell">{b.label}</text>
            <text x={b.x + 45} y={b.moon ? 99 : 86} className={`lv-tag small${b.moon ? " gold" : ""}`}>{b.sub}</text>
          </g>
        ))}
        <text x="160" y="126" className="lv-tag">3 signs × ~2.5 years ≈ 7½ years — “Sade Sati”</text>
      </svg>
      <figcaption>
        Sade Sati is Saturn&apos;s transit over the 12th, 1st and 2nd signs from your natal Moon.
        The middle phase — Saturn on the Moon itself — is usually the most demanding.
      </figcaption>
    </figure>
  );
}

const KOOTAS = [
  { name: "Nadi", pts: 8, what: "constitution & progeny" },
  { name: "Bhakoot", pts: 7, what: "Moon-sign distance" },
  { name: "Gana", pts: 6, what: "temperament class" },
  { name: "Graha Maitri", pts: 5, what: "Moon-lord friendship" },
  { name: "Yoni", pts: 4, what: "instinct & intimacy" },
  { name: "Tara", pts: 3, what: "nakshatra fortune" },
  { name: "Vashya", pts: 2, what: "mutual influence" },
  { name: "Varna", pts: 1, what: "attitude & work" },
];

function Kootas() {
  return (
    <figure className="lesson-visual">
      <div className="lv-kootas">
        {KOOTAS.map((k) => (
          <div className="lv-koota-row" key={k.name}>
            <span className="lv-koota-name">{k.name}</span>
            <span className="lv-koota-bar">
              <span style={{ width: `${(k.pts / 8) * 100}%` }} />
            </span>
            <span className="lv-koota-pts">{k.pts}</span>
            <span className="lv-koota-what muted small">{k.what}</span>
          </div>
        ))}
        <div className="lv-koota-total">Total <strong>36</strong> · 18+ acceptable · 24+ good · 28+ excellent</div>
      </div>
      <figcaption>
        The eight kootas and their weights — the three heaviest (Nadi, Bhakoot, Gana) hold 21 of the
        36 points, so they usually decide the verdict.
      </figcaption>
    </figure>
  );
}

// ── Vastu diagrams ─────────────────────────────────────────────────────────

/** The eight directions on a 3×3 grid: [col, row] with the centre left free. */
const DIR_CELLS: { dir: string; col: number; row: number; el: string; lord: string; cls: string }[] = [
  { dir: "NW", col: 0, row: 0, el: "Air", lord: "Vayavya", cls: "air" },
  { dir: "N", col: 1, row: 0, el: "Water", lord: "Kubera", cls: "water" },
  { dir: "NE", col: 2, row: 0, el: "Water", lord: "Ishanya", cls: "water" },
  { dir: "W", col: 0, row: 1, el: "Space", lord: "Varuna", cls: "" },
  { dir: "E", col: 2, row: 1, el: "Space", lord: "Indra", cls: "" },
  { dir: "SW", col: 0, row: 2, el: "Earth", lord: "Nairutya", cls: "earth" },
  { dir: "S", col: 1, row: 2, el: "Fire", lord: "Yama", cls: "fire" },
  { dir: "SE", col: 2, row: 2, el: "Fire", lord: "Agneya", cls: "fire" },
];

function VastuCompass() {
  const C = 100, H = 76;
  return (
    <figure className="lesson-visual">
      <svg viewBox="0 0 304 236" role="img" aria-label="The eight Vastu directions with their elements and lords">
        {DIR_CELLS.map((d) => {
          const x = 2 + d.col * C, y = 2 + d.row * H;
          return (
            <g key={d.dir}>
              <rect x={x} y={y} width={C} height={H} className={`lv-frame vz-${d.cls}`} />
              <text x={x + C / 2} y={y + 26} className="vz-dir">{d.dir}</text>
              <text x={x + C / 2} y={y + 44} className="vz-el">{d.el}</text>
              <text x={x + C / 2} y={y + 60} className="lv-tag small">{d.lord}</text>
            </g>
          );
        })}
        <rect x={102} y={78} width={C} height={H} className="lv-frame" />
        <text x={152} y={112} className="vz-dir gold">Brahmasthan</text>
        <text x={152} y={130} className="lv-tag small">keep open</text>
        <text x={152} y={148} className="lv-tag small">(centre)</text>
      </svg>
      <figcaption>
        North is up. The four corners carry the working elements — <strong>NE water</strong> (keep
        open), <strong>SE fire</strong>, <strong>SW earth</strong> (heaviest), <strong>NW air</strong>.
      </figcaption>
    </figure>
  );
}

const ZONE_USE: { col: number; row: number; label: string; cls: string }[] = [
  { col: 0, row: 0, label: "Bathroom · Garage", cls: "air" },
  { col: 1, row: 0, label: "Garden · Open", cls: "water" },
  { col: 2, row: 0, label: "Water · Pooja", cls: "water" },
  { col: 0, row: 1, label: "Dining · Storage", cls: "" },
  { col: 1, row: 1, label: "Brahmasthan", cls: "brahma" },
  { col: 2, row: 1, label: "Living · Pooja", cls: "" },
  { col: 0, row: 2, label: "Master bedroom", cls: "earth" },
  { col: 1, row: 2, label: "Stairs · Storage", cls: "earth" },
  { col: 2, row: 2, label: "Kitchen", cls: "fire" },
];

function VastuZones() {
  const S = 100;
  return (
    <figure className="lesson-visual">
      <svg viewBox="0 0 304 304" role="img" aria-label="The nine Vastu zones and their preferred uses">
        {ZONE_USE.map((z) => {
          const x = 2 + z.col * S, y = 2 + z.row * S;
          const dir = DIR_CELLS.find((d) => d.col === z.col && d.row === z.row)?.dir ?? "";
          return (
            <g key={`${z.col}-${z.row}`}>
              <rect x={x} y={y} width={S} height={S} className={`lv-frame vz-${z.cls}`} />
              {dir && <text x={x + 8} y={y + 18} className="vz-corner">{dir}</text>}
              <text x={x + S / 2} y={y + S / 2 + 4} className={`vz-use${z.cls === "brahma" ? " gold" : ""}`}>{z.label}</text>
              {z.cls === "brahma" && <text x={x + S / 2} y={y + S / 2 + 22} className="lv-tag small">keep it empty</text>}
            </g>
          );
        })}
      </svg>
      <figcaption>
        The 3×3 mandala with each zone&apos;s preferred use. The centre —
        the <strong>Brahmasthan</strong> — should stay open: no toilet, stairs or heavy storage.
      </figcaption>
    </figure>
  );
}

const ROOM_RULES: { room: string; ideal: string; cls: string; why: string }[] = [
  { room: "Kitchen", ideal: "SE", cls: "fire", why: "fire corner" },
  { room: "Master bedroom", ideal: "SW", cls: "earth", why: "heaviest, most stable" },
  { room: "Bathroom", ideal: "NW / W", cls: "air", why: "air — waste moves on" },
  { room: "Water source", ideal: "NE", cls: "water", why: "purest corner" },
  { room: "Staircase", ideal: "SW / S / W", cls: "earth", why: "weight belongs south-west" },
  { room: "Pooja room", ideal: "NE / E", cls: "water", why: "sunrise, purity" },
  { room: "Garden / open", ideal: "N / NE / E", cls: "water", why: "let light in" },
  { room: "Garage", ideal: "NW / SE", cls: "air", why: "movement corners" },
];

function VastuRooms() {
  return (
    <figure className="lesson-visual">
      <div className="vz-rooms">
        {ROOM_RULES.map((r) => (
          <div className="vz-room-row" key={r.room}>
            <span className="vz-room-name">{r.room}</span>
            <span className={`vz-room-dir vz-${r.cls}`}>{r.ideal}</span>
            <span className="muted small vz-room-why">{r.why}</span>
          </div>
        ))}
      </div>
      <figcaption>
        The placement table this app scores against. Prioritise the
        <strong> kitchen, master bedroom and water source</strong> — they move the score most.
      </figcaption>
    </figure>
  );
}

function VastuSlope() {
  return (
    <figure className="lesson-visual">
      <svg viewBox="0 0 304 170" role="img" aria-label="Preferred plot slope: land falling toward the north-east">
        {/* Plot as a tilted slab: high SW, low NE */}
        <polygon points="40,120 150,150 264,110 150,84" className="lv-frame" />
        <polygon points="40,120 150,150 150,124 40,96" className="vz-slab" />
        <polygon points="150,150 264,110 264,92 150,124" className="vz-slab dim" />
        <text x="46" y="86" className="vz-dir">SW</text>
        <text x="46" y="102" className="lv-tag small">high</text>
        <text x="248" y="80" className="vz-dir gold">NE</text>
        <text x="248" y="96" className="lv-tag small gold">low</text>
        <path d="M 70 70 L 240 62" className="lv-arrow" markerEnd="url(#lvArrow4)" />
        <defs>
          <marker id="lvArrow4" viewBox="0 0 8 8" refX="6" refY="4" markerWidth="7" markerHeight="7" orient="auto">
            <path d="M 0 0 L 8 4 L 0 8 z" className="lv-arrow-head" />
          </marker>
        </defs>
        <text x="152" y="44" className="lv-tag">water should drain this way ↘</text>
        <text x="152" y="166" className="lv-tag small">best: slope down toward N / NE / E · worst: toward SW</text>
      </svg>
      <figcaption>
        Ground that sits high in the south-west and falls toward the north-east is the classical
        ideal — heavy where it should be heavy, draining through the auspicious corner.
      </figcaption>
    </figure>
  );
}

export default function LessonVisual({ id }: { id: string }) {
  switch (id) {
    case "cast-flow": return <CastFlow />;
    case "north-layout": return <NorthLayout />;
    case "south-layout": return <SouthLayout />;
    case "read-example": return <ReadExample />;
    case "varga-split": return <VargaSplit />;
    case "sade-sati": return <SadeSati />;
    case "kootas": return <Kootas />;
    case "vastu-compass": return <VastuCompass />;
    case "vastu-zones": return <VastuZones />;
    case "vastu-rooms": return <VastuRooms />;
    case "vastu-slope": return <VastuSlope />;
    default: return null;
  }
}
