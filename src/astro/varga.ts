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

export type Varga =
  | "D1" | "D2" | "D3" | "D4" | "D7" | "D9" | "D10" | "D12"
  | "D16" | "D24" | "D30" | "D60";

export interface VargaInfo {
  code: Varga;
  division: number;
  name: string; // Sanskrit
  label: string; // e.g. "Navāṁśa (D9)"
  signifies: string; // short: what the chart is read for
  about: string; // fuller explanation of its significance and how it is used
  /**
   * Whether the chart toggle offers this varga. The finer divisions are
   * computed for the event-analysis karaka table (and, for D60, for birth-time
   * rectification) but not shown: twelve buttons is a lot of chrome, and D60
   * changes every two minutes, so browsing it with an approximate birth time
   * would suggest a precision nobody has. Flip the flag to surface one.
   */
  displayed: boolean;
}

// The commonly-taught set, in a sensible display order.
export const VARGAS: VargaInfo[] = [
  {
    displayed: true, code: "D1", division: 1, name: "Rāśi", label: "Rāśi (D1)",
    signifies: "the whole life — the main birth chart; House 1 is your Lagna",
    about:
      "The foundation. Each sign spans a full 30°, so this is the actual sky at birth — body, temperament and the overall shape of life. Every other divisional chart is read as a magnifying glass on one area of this one; a promise must first appear here to be confirmed elsewhere.",
  },
  {
    displayed: true, code: "D2", division: 2, name: "Horā", label: "Horā (D2)",
    signifies: "wealth and resources",
    about:
      "Splits each sign in two (Sun's and Moon's horā). Read for wealth, prosperity and the capacity to earn, hold and grow resources — your material sustenance.",
  },
  {
    displayed: true, code: "D3", division: 3, name: "Drekkāṇa", label: "Drekkāṇa (D3)",
    signifies: "siblings, courage and initiative",
    about:
      "Divides each sign into three. Read for brothers and sisters (co-borns), courage, drive, self-effort and initiative — how you push forward on your own strength.",
  },
  {
    displayed: true, code: "D7", division: 7, name: "Saptāṁśa", label: "Saptāṁśa (D7)",
    signifies: "children and progeny",
    about:
      "Seven parts per sign. Read for children, progeny and creative continuation — legacy and what you bring into being and pass on.",
  },
  {
    displayed: true, code: "D9", division: 9, name: "Navāṁśa", label: "Navāṁśa (D9)",
    signifies: "marriage, dharma and inner strength",
    about:
      "The most important chart after the Rāśi. Nine parts per sign. Read for marriage and the spouse, dharma (life-path), and — crucially — the true strength of every planet: a planet weak in D1 but strong here still delivers. When a planet sits in the same sign in D1 and D9 it is vargottama (very strong).",
  },
  {
    displayed: true, code: "D10", division: 10, name: "Daśāṁśa", label: "Daśāṁśa (D10)",
    signifies: "career, status and achievement",
    about:
      "Ten parts per sign. Read for career, profession, public standing, authority and worldly achievement — your karma in the world and how you are known.",
  },
  {
    displayed: true, code: "D12", division: 12, name: "Dvādaśāṁśa", label: "Dvādaśāṁśa (D12)",
    signifies: "parents and ancestry",
    about:
      "Twelve parts per sign. Read for parents, lineage, ancestry and inherited traits — the roots you come from and what flows down to you.",
  },
  {
    displayed: false, code: "D4", division: 4, name: "Chaturthāṁśa", label: "Chaturthāṁśa (D4)",
    signifies: "home, land and fixed property",
    about:
      "Each sign quartered into 7°30', the four parts falling on the kendras from it. Read for the house one lives in, land and immovable property, and the inner sense of having a place in the world.",
  },
  {
    displayed: false, code: "D16", division: 16, name: "Ṣoḍaśāṁśa", label: "Ṣoḍaśāṁśa (D16)",
    signifies: "vehicles, comforts and pleasures",
    about:
      "Sixteen parts of 1°52'30\", counted from Aries for movable signs, Leo for fixed and Sagittarius for dual. Read for conveyances and the material comforts that come with them — and for the happiness, or lack of it, that they bring.",
  },
  {
    displayed: false, code: "D24", division: 24, name: "Siddhāṁśa", label: "Siddhāṁśa (D24)",
    signifies: "learning, education and skill",
    about:
      "Twenty-four parts of 1°15', counted from Leo in odd signs and Cancer in even. The classical chart of formal learning and acquired skill — degrees, examinations and the depth of what is actually mastered.",
  },
  {
    displayed: false, code: "D30", division: 30, name: "Triṁśāṁśa", label: "Triṁśāṁśa (D30)",
    signifies: "misfortune, illness and hidden weakness",
    about:
      "The one varga that is not an equal division: the 30° are split into five unequal stretches ruled by Mars, Saturn, Jupiter, Mercury and Venus, in that order from an odd sign and reversed from an even one. The Sun and Moon own none. Read for evils, disease and the flaws that surface under pressure.",
  },
  {
    displayed: false, code: "D60", division: 60, name: "Ṣaṣṭyāṁśa", label: "Ṣaṣṭyāṁśa (D60)",
    signifies: "the sum of past karma — and the classical rectification chart",
    about:
      "Sixty parts of just 30' each, which Parashara weights above every other varga for judging a planet's real quality. Because it changes every two minutes of birth time it is the traditional instrument for rectifying an uncertain one — and, for the same reason, worthless unless the time is already known closely.",
  },
];

/** The vargas the chart toggle offers. See VargaInfo.displayed. */
export const DISPLAYED_VARGAS: VargaInfo[] = VARGAS.filter((v) => v.displayed);

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

    case "D4": {
      // 7°30' each. The four quarters fall on the kendras from the sign:
      // itself, the 4th, the 7th and the 10th.
      const part = Math.floor(deg / 7.5); // 0..3
      return (sign + part * 3) % 12;
    }

    case "D16": {
      // 1°52'30" each. Movable signs count from Aries, fixed from Leo, dual
      // from Sagittarius; the sixteen parts then run consecutively.
      const part = Math.floor(deg / (30 / 16)); // 0..15
      const start = nature === 0 ? 0 : nature === 1 ? 4 : 8;
      return (start + part) % 12;
    }

    case "D24": {
      // 1°15' each. Odd signs count from Leo, even signs from Cancer.
      const part = Math.floor(deg / 1.25); // 0..23
      const start = oddRashi ? 4 : 3;
      return (start + part) % 12;
    }

    case "D30": {
      // The one varga that is NOT an equal division. The 30° are split into
      // five unequal stretches ruled by the five non-luminaries, and the sign
      // is that ruler's own — Mars gives Aries from an odd sign and Scorpio
      // from an even one, and so on. The Sun and Moon own no trimsamsa.
      if (oddRashi) {
        if (deg < 5) return 0;   // Mars    -> Aries
        if (deg < 10) return 10; // Saturn  -> Aquarius
        if (deg < 18) return 8;  // Jupiter -> Sagittarius
        if (deg < 25) return 2;  // Mercury -> Gemini
        return 6;                // Venus   -> Libra
      }
      // Even signs take the same five rulers in the reverse order, with the
      // spans mirrored.
      if (deg < 5) return 1;   // Venus   -> Taurus
      if (deg < 12) return 5;  // Mercury -> Virgo
      if (deg < 20) return 11; // Jupiter -> Pisces
      if (deg < 25) return 9;  // Saturn  -> Capricorn
      return 7;                // Mars    -> Scorpio
    }

    case "D60": {
      // 0°30' each — the finest varga in common use, and the reason it is the
      // classical rectification chart: it changes every two minutes of birth
      // time. Doubling the degrees and counting that many signs from the one
      // occupied is the Parashari rule.
      const part = Math.floor(deg * 2) % 12; // 0..11
      return (sign + part) % 12;
    }
  }
}
