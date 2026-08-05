// Divisional charts (Vargas). A rashi (30°) is subdivided into N parts and each
// part is mapped to a sign by classical (Parashari) rules; the resulting sign
// chart magnifies a particular area of life. D1 is the birth chart itself.
//
// Sign parity/nature (0-based sign index):
//   odd rashi  (Aries, Gemini, …)      -> signIndex % 2 === 0
//   movable    (Aries, Cancer, …)      -> signIndex % 3 === 0
//   fixed      (Taurus, Leo, …)        -> signIndex % 3 === 1
//   dual       (Gemini, Virgo, …)      -> signIndex % 3 === 2

import { norm360 } from "./math";

export type Varga = "D1" | "D2" | "D3" | "D7" | "D9" | "D10" | "D12";

export interface VargaInfo {
  code: Varga;
  division: number;
  name: string; // Sanskrit
  label: string; // e.g. "Navāṁśa (D9)"
  signifies: string; // short: what the chart is read for
  about: string; // fuller explanation of its significance and how it is used
}

// The commonly-taught set, in a sensible display order.
export const VARGAS: VargaInfo[] = [
  {
    code: "D1", division: 1, name: "Rāśi", label: "Rāśi (D1)",
    signifies: "the whole life — the main birth chart; House 1 is your Lagna",
    about:
      "The foundation. Each sign spans a full 30°, so this is the actual sky at birth — body, temperament and the overall shape of life. Every other divisional chart is read as a magnifying glass on one area of this one; a promise must first appear here to be confirmed elsewhere.",
  },
  {
    code: "D2", division: 2, name: "Horā", label: "Horā (D2)",
    signifies: "wealth and resources",
    about:
      "Splits each sign in two (Sun's and Moon's horā). Read for wealth, prosperity and the capacity to earn, hold and grow resources — your material sustenance.",
  },
  {
    code: "D3", division: 3, name: "Drekkāṇa", label: "Drekkāṇa (D3)",
    signifies: "siblings, courage and initiative",
    about:
      "Divides each sign into three. Read for brothers and sisters (co-borns), courage, drive, self-effort and initiative — how you push forward on your own strength.",
  },
  {
    code: "D7", division: 7, name: "Saptāṁśa", label: "Saptāṁśa (D7)",
    signifies: "children and progeny",
    about:
      "Seven parts per sign. Read for children, progeny and creative continuation — legacy and what you bring into being and pass on.",
  },
  {
    code: "D9", division: 9, name: "Navāṁśa", label: "Navāṁśa (D9)",
    signifies: "marriage, dharma and inner strength",
    about:
      "The most important chart after the Rāśi. Nine parts per sign. Read for marriage and the spouse, dharma (life-path), and — crucially — the true strength of every planet: a planet weak in D1 but strong here still delivers. When a planet sits in the same sign in D1 and D9 it is vargottama (very strong).",
  },
  {
    code: "D10", division: 10, name: "Daśāṁśa", label: "Daśāṁśa (D10)",
    signifies: "career, status and achievement",
    about:
      "Ten parts per sign. Read for career, profession, public standing, authority and worldly achievement — your karma in the world and how you are known.",
  },
  {
    code: "D12", division: 12, name: "Dvādaśāṁśa", label: "Dvādaśāṁśa (D12)",
    signifies: "parents and ancestry",
    about:
      "Twelve parts per sign. Read for parents, lineage, ancestry and inherited traits — the roots you come from and what flows down to you.",
  },
];

export const VARGA_BY_CODE: Record<Varga, VargaInfo> = Object.fromEntries(
  VARGAS.map((v) => [v.code, v]),
) as Record<Varga, VargaInfo>;

/**
 * Sign (0..11) occupied by a body at ecliptic longitude `longitude` in the given
 * divisional chart.
 */
export function divisionalSign(longitude: number, varga: Varga): number {
  const lon = norm360(longitude);
  const sign = Math.floor(lon / 30);
  const deg = lon - sign * 30; // 0..30 within the sign
  const oddRashi = sign % 2 === 0;
  const nature = sign % 3; // 0 movable, 1 fixed, 2 dual

  switch (varga) {
    case "D1":
      return sign;

    case "D2": {
      // Parashara Hora: odd rashi -> Leo then Cancer; even rashi -> Cancer then Leo.
      const firstHalf = deg < 15;
      if (oddRashi) return firstHalf ? 4 : 3; // Leo / Cancer
      return firstHalf ? 3 : 4; // Cancer / Leo
    }

    case "D3": {
      // 10° each: 1st part same sign, 2nd part 5th, 3rd part 9th from it.
      const part = Math.floor(deg / 10); // 0,1,2
      return (sign + part * 4) % 12;
    }

    case "D7": {
      // 30/7° each. Odd rashi counts from the sign; even rashi from the 7th.
      const part = Math.floor(deg / (30 / 7)); // 0..6
      const start = oddRashi ? sign : (sign + 6) % 12;
      return (start + part) % 12;
    }

    case "D9": {
      // 3°20' each. Movable -> from self, fixed -> from 9th, dual -> from 5th.
      const part = Math.floor(deg / (30 / 9)); // 0..8
      const start = nature === 0 ? sign : nature === 1 ? (sign + 8) % 12 : (sign + 4) % 12;
      return (start + part) % 12;
    }

    case "D10": {
      // 3° each. Odd rashi counts from the sign; even rashi from the 9th.
      const part = Math.floor(deg / 3); // 0..9
      const start = oddRashi ? sign : (sign + 8) % 12;
      return (start + part) % 12;
    }

    case "D12": {
      // 2°30' each, counted from the sign itself.
      const part = Math.floor(deg / 2.5); // 0..11
      return (sign + part) % 12;
    }
  }
}
