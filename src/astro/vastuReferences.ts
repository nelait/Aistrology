/**
 * Vastu Shastra classical references for LLM grounding.
 *
 * Same pattern as healthReferences.ts — provides textual evidence
 * from classical texts so the LLM can cite them in its justifications.
 */

import type { VastuResult, VastuFactor, AstroVastuFactor } from "./vastu";

interface Reference {
  text: string;
  source: string;
}

/** Direction–element classical mappings. */
const DIRECTION_REFS: Record<string, Reference> = {
  NE: {
    text: "The Northeast (Ishanya) is the most sacred corner, ruled by Lord Shiva. It represents the water element and should be kept open, clean, and light. The borewell, water tank, or pooja room should ideally be placed here.",
    source: "Vastu Shastra — Mayamatam, Ch. 7",
  },
  E: {
    text: "The East direction is ruled by Lord Indra and represents the dawn and new beginnings. The main entrance facing East ensures prosperity and health. It is the direction of the Sun's life-giving energy.",
    source: "Brihat Samhita — Varahamihira, Ch. 53",
  },
  SE: {
    text: "The Southeast (Agneya) is the fire corner, ruled by Agni. The kitchen and fire-related activities should be placed here. Cooking while facing East is considered highly auspicious.",
    source: "Vastu Shastra — Vishwakarma Vastu Shastra, Ch. 12",
  },
  S: {
    text: "The South direction is ruled by Yama (lord of death and dharma). Heavy construction, storage, or the master bedroom can be placed here. The South wall should be higher and heavier than the North.",
    source: "Manasara — Architectural Treatise, Ch. 9",
  },
  SW: {
    text: "The Southwest (Nairutya) represents the earth element and stability. It is ideal for the master bedroom and heavy storage. The SW corner should be the heaviest and tallest part of the structure.",
    source: "Samarangana Sutradhara — King Bhoja, Ch. 15",
  },
  W: {
    text: "The West direction is ruled by Varuna (lord of waters and cosmic order). It is suitable for dining rooms, children's rooms, and study areas. The West wall should be moderately heavy.",
    source: "Vastu Shastra — Mayamatam, Ch. 11",
  },
  NW: {
    text: "The Northwest (Vayavya) is the wind corner, ruled by Vayu. It is ideal for guest rooms, bathrooms, and garages. This corner promotes movement and change.",
    source: "Brihat Samhita — Varahamihira, Ch. 53",
  },
  N: {
    text: "The North direction is ruled by Kubera (lord of wealth). Keeping the North open and light attracts prosperity. The main entrance or living room facing North is considered auspicious.",
    source: "Vastu Purusha Mandala — Classical Vastu Literature",
  },
};

/** Room-specific classical references. */
const ROOM_REFS: Record<string, Reference[]> = {
  Kitchen: [
    {
      text: "The kitchen should be in the Southeast corner, the domain of Agni. The cook should face East while preparing food. Fire and water should not be placed side by side.",
      source: "Vastu Shastra — Vishwakarma Vastu Shastra, Ch. 12",
    },
    {
      text: "If the kitchen cannot be placed in the SE, the NW (Vayu corner) is the secondary option. Kitchens in the NE or SW are inauspicious and lead to health and financial issues.",
      source: "Manasara — Architectural Treatise, Ch. 14",
    },
  ],
  "Master Bedroom": [
    {
      text: "The master bedroom should be in the Southwest to provide stability, grounding, and the authority of the head of the household. The bed should be placed so the head points South or East.",
      source: "Vastu Purusha Mandala — Classical Vastu Literature",
    },
  ],
  Bathroom: [
    {
      text: "Toilets and bathrooms should be in the West or Northwest direction. They should never be in the Northeast (Ishanya) as this pollutes the most sacred corner.",
      source: "Brihat Samhita — Varahamihira, Ch. 53",
    },
  ],
  "Pooja Room": [
    {
      text: "The prayer room should be in the Northeast corner, the abode of Lord Shiva. Alternatively, the East direction is acceptable. The devotee should face East or North while praying.",
      source: "Vastu Shastra — Mayamatam, Ch. 7",
    },
  ],
  "Main Entrance": [
    {
      text: "The main entrance is the mouth of the Vastu Purusha. Entrances in the North, East, or Northeast are most auspicious. The door should open inward (clockwise) and be the largest door in the house.",
      source: "Vastu Purusha Mandala — Classical Vastu Literature",
    },
  ],
  "Property Facing": [
    {
      text: "The facing direction of a property should align with the native's Lagna (ascendant) for maximum benefit. Fire signs favour East, Earth signs favour South, Air signs favour West, and Water signs favour North.",
      source: "Jyotish-Vastu Correlation — Brihat Jataka, Ch. 1 & Brihat Samhita, Ch. 53",
    },
  ],
  "Plot Shape": [
    {
      text: "A square plot (Chaturbhuja) is the most auspicious, representing the balanced Vastu Purusha. Rectangular plots (Ayatakara) aligned N-S or E-W are also favourable. Irregular or triangular plots disrupt the cosmic energy grid.",
      source: "Manasara — Architectural Treatise, Ch. 5",
    },
  ],
  "Land Slope": [
    {
      text: "The ideal slope is from Southwest (high) to Northeast (low), allowing water and positive energy to flow toward Ishanya. A SW-sloping land reverses this flow and is considered highly inauspicious.",
      source: "Vastu Shastra — Mayamatam, Ch. 3",
    },
  ],
};

/** Astro-Vastu cross-reference texts. */
const ASTRO_REFS: Record<string, Reference[]> = {
  "Lagna Direction Compatibility": [
    {
      text: "The Lagna (ascendant) at birth determines the native's primary constitutional direction. Aligning one's dwelling with this direction amplifies the positive influences of the ascendant lord.",
      source: "Jyotish-Vastu Integration — Parashari Jyotish & Vastu Purusha Mandala",
    },
  ],
  "4th House Lord (Property House)": [
    {
      text: "The 4th house (Sukha Bhava) governs property, vehicles, mother, and domestic happiness. A strong 4th lord in a kendra or trikona ensures property fortune. A debilitated or afflicted 4th lord causes difficulties in property matters.",
      source: "Brihat Parashara Hora Shastra — Ch. 15 (Bhava Phala)",
    },
  ],
  "Mars (Bhoomi Karaka — Land Significator)": [
    {
      text: "Mars is the Bhoomi Karaka (significator of land, property, and real estate). Mars in the 4th house or aspecting it strongly indicates property ownership. Afflicted Mars may cause disputes related to land.",
      source: "Jataka Parijata — Ch. 9 (Karaka Theory)",
    },
  ],
  "Venus (Sukha Karaka — Comfort Significator)": [
    {
      text: "Venus governs luxuries, comfort, and aesthetic beauty of the home. A strong Venus ensures a beautiful, well-furnished dwelling. Venus in kendras (1, 4, 7, 10) indicates a comfortable and harmonious domestic environment.",
      source: "Brihat Parashara Hora Shastra — Ch. 3 (Graha Gunas)",
    },
  ],
};

// ── Grounding functions ────────────────────────────────────────────────────

/** Get references for a room factor finding. */
export function vastuRoomGrounding(factor: VastuFactor): string[] {
  const refs: string[] = [];

  // Direction reference
  const dirMatch = factor.finding.match(/\b(N|NE|E|SE|S|SW|W|NW)\b/);
  if (dirMatch && DIRECTION_REFS[dirMatch[1]]) {
    const d = DIRECTION_REFS[dirMatch[1]];
    refs.push(`${d.text} — ${d.source}`);
  }

  // Room-specific references
  const roomRefs = ROOM_REFS[factor.area];
  if (roomRefs) {
    for (const r of roomRefs) refs.push(`${r.text} — ${r.source}`);
  }

  return refs;
}

/** Get references for an astrological factor. */
export function vastuAstroGrounding(factor: AstroVastuFactor): string[] {
  const refs = ASTRO_REFS[factor.factor];
  if (!refs) return [];
  return refs.map((r) => `${r.text} — ${r.source}`);
}

/** Get all references for an entire VastuResult (for the LLM prompt). */
export function vastuFullGrounding(result: VastuResult): string[] {
  const all: string[] = [];
  for (const f of result.roomFactors) all.push(...vastuRoomGrounding(f));
  for (const f of result.astroFactors) all.push(...vastuAstroGrounding(f));
  // Deduplicate
  return [...new Set(all)];
}
