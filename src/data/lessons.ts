// Structured teaching content. Each lesson is self-contained and progresses
// from foundations to interpretation, so the app teaches astrology while it
// computes it. Content is written in plain language with the Sanskrit terms
// introduced alongside their meaning.

export interface LessonSection {
  heading: string;
  body: string;
  points?: string[];
  /** Id of an illustrative diagram rendered by <LessonVisual/> after the body. */
  visual?: string;
}

export interface Lesson {
  id: string;
  title: string;
  /** Learning track: Beginner (foundations) → Advanced (technique) → Pro (interpretation). */
  level: "Beginner" | "Advanced" | "Pro";
  /** Approximate reading time in minutes. */
  minutes: number;
  /** Optional deep link into the app tab where this topic appears live. */
  seeIn?: { tab: string; label: string };
  summary: string;
  sections: LessonSection[];
}

export const LESSONS: Lesson[] = [
  {
    id: "what-is-jyotisha",
    title: "1 · What Vedic Astrology Is",
    level: "Beginner",
    minutes: 4,
    seeIn: { tab: "chart", label: "your Kundli" },
    summary:
      "The worldview behind Jyotisha, how it differs from Western astrology, and what a birth chart actually represents.",
    sections: [
      {
        heading: "Jyotisha — the science of light",
        body:
          "Vedic astrology is called Jyotisha, 'the science of light'. It is one of the six Vedangas (limbs of the Veda) and treats the sky as a clock and a map: the positions of the Sun, Moon and planets at the moment of your birth describe the karmic pattern you are born into — your tendencies, timing and lessons. Astrology in this tradition is a tool for self-understanding and skilful action, never a statement that the future is fixed.",
      },
      {
        heading: "Sidereal vs. tropical zodiac",
        body:
          "The single biggest difference from Western astrology is the zodiac used. Western astrology uses the tropical zodiac, tied to the seasons (0° Aries = the spring equinox). Vedic astrology uses the sidereal zodiac, tied to the actual fixed stars. Because Earth's axis slowly wobbles (precession), the two have drifted about 24° apart. The correction between them is the ayanamsa. This app uses the Lahiri (Chitrapaksha) ayanamsa, the Indian government standard.",
        points: [
          "Tropical: 0° Aries = spring equinox (season-based).",
          "Sidereal: 0° Aries = fixed against the stars (star-based).",
          "Ayanamsa ≈ 24° today — why your 'Sun sign' often shifts back one sign in Vedic astrology.",
        ],
      },
      {
        heading: "What the chart shows",
        body:
          "A Vedic birth chart (Kundli or Janma Kundali) is a snapshot of the sky from your exact birth time and place. It maps twelve signs (Rashis), twelve houses (Bhavas), nine planets (Grahas) and twenty-seven lunar mansions (Nakshatras). Reading it is the art of combining these layers.",
      },
    ],
  },
  {
    id: "chart-casting",
    title: "2 · How a Chart Is Cast",
    level: "Beginner",
    minutes: 4,
    seeIn: { tab: "chart", label: "your Kundli" },
    summary:
      "What actually happens between typing your birth details and seeing a finished Kundli — and why the exact birth time matters so much.",
    sections: [
      {
        heading: "Three ingredients: date, time, place",
        body:
          "A chart is a photograph of the sky, and three details aim the camera. The DATE fixes where the planets are along the zodiac. The exact TIME fixes which sign was rising on the eastern horizon — the Lagna (Ascendant). The PLACE fixes where that horizon actually is: two people born at the same moment in Delhi and New York have different rising signs.",
        visual: "cast-flow",
        points: [
          "Date → planet positions (they move slowly, so the date is enough).",
          "Time → the Lagna, which changes sign roughly every 2 hours.",
          "Place → the horizon (latitude/longitude), plus the timezone to convert local time.",
        ],
      },
      {
        heading: "From sky to chart",
        body:
          "The app computes each planet's position along the ecliptic (its longitude), subtracts the ayanamsa to get sidereal positions, and works out the rising degree for your place and time. The rising sign becomes house 1, and under the whole-sign system each following sign becomes the next house. Every placement you see — sign, house, nakshatra — falls out of those three inputs.",
      },
      {
        heading: "Why minutes matter",
        body:
          "Because the Lagna moves one full sign about every two hours, an uncertain birth time is the single biggest source of error. A 30-minute slip can shift the Lagna — which re-numbers every house in the chart. If the time is approximate, treat house-based readings cautiously and lean on the Moon (its sign and nakshatra change much more slowly).",
        points: [
          "Lagna: changes sign ~every 2 hours.",
          "Moon: changes sign ~every 2.5 days, nakshatra ~daily.",
          "Unsure of the time? Start from the Moon chart and the planets' signs.",
        ],
      },
    ],
  },
  {
    id: "chart-styles",
    title: "3 · Chart Styles — North & South Indian",
    level: "Beginner",
    minutes: 5,
    seeIn: { tab: "chart", label: "the North/South toggle" },
    summary:
      "The same sky can be drawn two ways. Learn to find the Lagna, the houses and the signs in both the North Indian diamond and the South Indian grid.",
    sections: [
      {
        heading: "North Indian: houses stay fixed",
        body:
          "In the North Indian style the chart is a diamond. The HOUSES never move: house 1 (the Lagna) is always the top-centre diamond, and houses count anti-clockwise around the chart. What changes from person to person are the SIGNS, written as numbers (1 = Aries … 12 = Pisces) inside each house. If house 1 shows '5', your Lagna is Leo, house 2 holds Virgo (6), and so on.",
        visual: "north-layout",
        points: [
          "Houses are fixed positions; read anti-clockwise from the top diamond.",
          "The number inside a house is its sign (1 = Aries … 12 = Pisces).",
          "Best for house-based analysis at a glance.",
        ],
      },
      {
        heading: "South Indian: signs stay fixed",
        body:
          "The South Indian style is a 4×4 grid with the middle empty. Here the SIGNS never move: Aries always sits in the same box (second box of the top row), and the zodiac runs clockwise around the frame. The Lagna is marked with a diagonal stroke in whichever sign was rising; that box is house 1, and houses count clockwise from it.",
        visual: "south-layout",
        points: [
          "Signs are fixed boxes; the zodiac runs clockwise.",
          "The diagonal stroke marks the Lagna — count houses clockwise from there.",
          "Best for spotting sign-based patterns and dignities quickly.",
        ],
      },
      {
        heading: "Which should you use?",
        body:
          "They contain identical information — the choice is regional habit. This app draws both (use the North/South toggle above the chart). While learning, pick one style and stay with it: most readers find the North style easier for houses and the South style easier for signs. Every lesson here works in either.",
      },
    ],
  },
  {
    id: "grahas",
    title: "4 · The Nine Grahas (Planets)",
    level: "Beginner",
    minutes: 5,
    seeIn: { tab: "chart", label: "the planet table" },
    summary:
      "The nine 'seizers' — seven visible bodies plus the two lunar nodes — and what each governs.",
    sections: [
      {
        heading: "Why nine?",
        body:
          "Graha means 'that which seizes or influences'. Vedic astrology uses the seven classical bodies visible to the eye — Sun, Moon, Mars, Mercury, Jupiter, Venus, Saturn — plus two mathematical points where the Moon's orbit crosses the ecliptic: Rahu (north node) and Ketu (south node). The distant Uranus, Neptune and Pluto are not part of the classical system.",
      },
      {
        heading: "Natural benefics and malefics",
        body:
          "Planets have a natural temperament. Jupiter and Venus (and a waxing Moon and unafflicted Mercury) are natural benefics — gentle, supportive. The Sun, Mars, Saturn, Rahu and Ketu are natural malefics — they create friction, but that friction builds strength and maturity. 'Malefic' does not mean 'bad'; Saturn's discipline and the Sun's authority are essential.",
        points: [
          "Benefics: Jupiter, Venus, waxing Moon, well-placed Mercury.",
          "Malefics: Sun, Mars, Saturn, Rahu, Ketu, waning Moon.",
          "Mercury takes on the nature of whatever it sits with.",
        ],
      },
      {
        heading: "Karakas — significators",
        body:
          "Each graha 'stands for' certain areas of life, called its karakatva. The Sun is the soul and father; the Moon the mind and mother; Mars energy and siblings; Mercury intellect and speech; Jupiter wisdom, wealth and children; Venus love and comfort; Saturn discipline and longevity; Rahu ambition and the foreign; Ketu detachment and spirituality. Learn these and half of interpretation is done.",
      },
    ],
  },
  {
    id: "rashis",
    title: "5 · The Twelve Rashis (Signs)",
    level: "Beginner",
    minutes: 5,
    seeIn: { tab: "chart", label: "your chart wheel" },
    summary:
      "How the twelve signs are organised by element and mode, and what each planet's placement in a sign means.",
    sections: [
      {
        heading: "Elements and modes",
        body:
          "The twelve signs cycle through four elements (Fire, Earth, Air, Water) and three modes (Movable/Chara, Fixed/Sthira, Dual/Dvisvabhava). A sign's meaning is largely its element (motivation) plus its mode (how it acts). Aries is fiery and movable — pioneering; Taurus is earthy and fixed — steady; and so on.",
        points: [
          "Fire (Aries, Leo, Sagittarius): spirit, drive, inspiration.",
          "Earth (Taurus, Virgo, Capricorn): practicality, matter, results.",
          "Air (Gemini, Libra, Aquarius): intellect, relationship, ideas.",
          "Water (Cancer, Scorpio, Pisces): emotion, intuition, depth.",
        ],
      },
      {
        heading: "Rulership",
        body:
          "Every sign is owned by a graha, and a planet is strong and comfortable in the signs it rules. The Sun rules Leo and the Moon Cancer; the other five planets each rule two signs. When a planet sits in its own sign, its significations flourish.",
      },
      {
        heading: "Dignity: exaltation and debilitation",
        body:
          "Beyond ownership, each planet has one sign of exaltation (its peak strength) and the opposite sign of debilitation (its weakest expression). The Sun exalts in Aries and falls in Libra; Saturn exalts in Libra and falls in Aries, and so on. A planet's dignity is the first thing to check when judging its strength.",
      },
    ],
  },
  {
    id: "bhavas",
    title: "6 · The Twelve Bhavas (Houses)",
    level: "Beginner",
    minutes: 5,
    seeIn: { tab: "chart", label: "houses in your chart" },
    summary:
      "The twelve life areas, the four house categories, and why the Ascendant is the anchor of the whole chart.",
    sections: [
      {
        heading: "The Ascendant (Lagna)",
        body:
          "The most important point in the chart is the Ascendant or Lagna — the sign rising on the eastern horizon at your birth. It becomes the 1st house and sets the frame for all the others. Because it changes roughly every two hours, an accurate birth time is essential; even a small error can shift the Lagna and every house with it.",
      },
      {
        heading: "What the houses mean",
        body:
          "Each house governs a domain of life: 1st self and body, 2nd wealth and family, 3rd courage and siblings, 4th home and mother, 5th children and creativity, 6th health and enemies, 7th marriage and partnership, 8th transformation and longevity, 9th fortune and dharma, 10th career and status, 11th gains and networks, 12th loss, expense and liberation.",
      },
      {
        heading: "House categories",
        body:
          "Houses are grouped by function. Kendras (1, 4, 7, 10) are the pillars of action. Trikonas (1, 5, 9) are houses of fortune and dharma — the most benefic. Dusthanas (6, 8, 12) are houses of difficulty and growth through challenge. Upachayas (3, 6, 10, 11) improve over time. This app uses whole-sign houses, the oldest and most common Vedic system, where each house is exactly one sign.",
        points: [
          "Kendra (angles): 1, 4, 7, 10 — strength and stability.",
          "Trikona (trines): 1, 5, 9 — fortune and dharma.",
          "Dusthana: 6, 8, 12 — obstacles, transformation, letting go.",
          "Maraka: 2, 7 — houses connected with life's endings.",
        ],
      },
    ],
  },
  {
    id: "chart-reading",
    title: "7 · Reading a Chart, Step by Step",
    level: "Beginner",
    minutes: 6,
    seeIn: { tab: "chart", label: "your chart & planet table" },
    summary:
      "A five-step routine that turns a chart full of symbols into a readable story. Practise it on your own Kundli as you go.",
    sections: [
      {
        heading: "Steps 1–2: the Lagna, then its lord",
        body:
          "Start at house 1 and note its sign — that is the chart's frame: the body, temperament and general direction of life. Then find that sign's ruling planet (the Lagna lord) and see which house it occupies: the Lagna lord carries the person's core energy into that life area. A Leo Lagna with the Sun in house 10 points life strongly toward career and visibility.",
        visual: "read-example",
      },
      {
        heading: "Steps 3–4: scan the planets",
        body:
          "Next, walk through the nine planets. For each, ask two questions. WHERE is it — which house (life area) and which sign (style)? And HOW STRONG is it — exalted, in its own sign, or debilitated (the Dignity column in the planet table)? Strong planets deliver their houses' results confidently; afflicted ones need more effort. Note anything sitting in houses 1, 4, 7 or 10 — the chart's power positions.",
        points: [
          "Where: house = the life area, sign = the flavour it acts with.",
          "How strong: Exalted / Own sign are assets; Debilitated needs support.",
          "Natural benefics (Jupiter, Venus, Moon, Mercury) help where they sit; Saturn, Mars, Rahu, Ketu discipline or disrupt.",
        ],
      },
      {
        heading: "Step 5: the Moon and the clock",
        body:
          "Finally, read the Moon — its sign and nakshatra describe the mind and emotional style — and check the running Vimshottari Dasha to know WHICH planet's promises are active right now. A chart shows potential; the dasha shows timing. With these five steps you can already sketch a person: frame (Lagna), driver (Lagna lord), assets (strong planets), mind (Moon), season (dasha).",
        points: [
          "① Lagna sign → the frame",
          "② Lagna lord's house → where life's energy goes",
          "③ Each planet: house + sign",
          "④ Dignity: strong or struggling?",
          "⑤ Moon + current dasha → mind and timing",
        ],
      },
    ],
  },
  {
    id: "nakshatras",
    title: "8 · The 27 Nakshatras (Lunar Mansions)",
    level: "Advanced",
    minutes: 4,
    seeIn: { tab: "chart", label: "the nakshatra column" },
    summary:
      "The lunar zodiac that adds fine detail to any placement and drives the timing system.",
    sections: [
      {
        heading: "The Moon's path",
        body:
          "Before the twelve signs, Vedic astrologers divided the sky into 27 nakshatras — one for each day of the Moon's roughly 27-day journey through the zodiac. Each nakshatra spans 13°20' and carries its own deity, symbol, energy and ruling planet. The nakshatra of your Moon (your Janma Nakshatra) is a deeply personal signature.",
      },
      {
        heading: "Padas",
        body:
          "Each nakshatra divides into four quarters called padas of 3°20' each. The pada links the nakshatra to the Navamsa (D9) divisional chart and refines the meaning of a planet's position further still.",
      },
      {
        heading: "Why they matter for timing",
        body:
          "The nakshatra of the Moon at birth determines where you begin in the Vimshottari Dasha cycle — the primary system for predicting when events unfold. This is why the nakshatra is not just descriptive but the engine of prediction.",
      },
    ],
  },
  {
    id: "dashas",
    title: "9 · Vimshottari Dasha (Timing)",
    level: "Advanced",
    minutes: 5,
    seeIn: { tab: "dasha", label: "your Dasha timeline" },
    summary:
      "The 120-year planetary period system that tells you which planet is 'ruling' each chapter of your life.",
    sections: [
      {
        heading: "The idea of a dasha",
        body:
          "A birth chart shows potential; a dasha shows timing. In the Vimshottari system, life unfolds as a sequence of planetary periods (Mahadashas) totalling 120 years. Whichever planet's period is running colours that entire chapter with its significations, promising and delivering the results it is capable of in your chart.",
      },
      {
        heading: "How it is calculated",
        body:
          "The cycle is keyed to the Moon's nakshatra at birth. Each nakshatra has a ruling planet, and that planet's dasha is the one you are born into — already partly elapsed, so your first period is a 'balance'. The nine periods run in a fixed order (Ketu 7, Venus 20, Sun 6, Moon 10, Mars 7, Rahu 18, Jupiter 16, Saturn 19, Mercury 17 years).",
        points: [
          "Mahadasha: the major period (years).",
          "Antardasha / Bhukti: sub-periods within it that fine-tune the timing.",
          "Results depend on how well that planet is placed in YOUR chart.",
        ],
      },
      {
        heading: "Reading a dasha",
        body:
          "A benefic, well-placed planet tends to give its best results during its own period; a weak or afflicted one, its more difficult ones. The interplay of the major-period lord and the sub-period lord — their friendship, houses and dignity — is where precise prediction lives.",
      },
    ],
  },
  {
    id: "aspects",
    title: "10 · Drishti (Planetary Aspects)",
    level: "Advanced",
    minutes: 4,
    seeIn: { tab: "predictions", label: "your predictions" },
    summary:
      "How planets 'see' and influence other houses across the chart.",
    sections: [
      {
        heading: "The 7th aspect",
        body:
          "Every planet casts its gaze — drishti — on the house directly opposite it, the 7th from itself. A planet influences not only the house it sits in but the house and planets it aspects, for better or worse depending on its nature.",
      },
      {
        heading: "Special aspects",
        body:
          "Three planets have extra reach. Mars additionally aspects the 4th and 8th from itself (a restless, forceful gaze). Jupiter aspects the 5th and 9th (a blessing, expanding wherever it looks). Saturn aspects the 3rd and 10th (a sobering, disciplining gaze). Rahu and Ketu are often given 5th, 7th and 9th aspects.",
        points: [
          "All planets: 7th aspect.",
          "Mars: 4th, 7th, 8th.",
          "Jupiter: 5th, 7th, 9th (most benefic).",
          "Saturn: 3rd, 7th, 10th.",
        ],
      },
    ],
  },
  {
    id: "vargas",
    title: "11 · Divisional Charts (Vargas) & the Navamsa",
    level: "Advanced",
    minutes: 5,
    seeIn: { tab: "chart", label: "the D1–D12 selector" },
    summary:
      "How one chart becomes sixteen: each sign is subdivided into finer charts that zoom into specific life areas — and why the D9 (Navamsa) is the most important of them.",
    sections: [
      {
        heading: "Zooming into a sign",
        body:
          "A varga (divisional chart) slices every sign into equal parts and promotes each part to a full sign of its own. The Navamsa (D9) divides each 30° sign into nine slices of 3°20'. A planet at 17° Aries falls in the 6th slice, so in the D9 it occupies a different sign — revealing a finer layer beneath the birth chart. Each varga has a theme: D9 for marriage and inner strength, D10 for career, D7 for children, D2 for wealth.",
        visual: "varga-split",
        points: [
          "D1 (Rashi) — the trunk: body, life as a whole.",
          "D9 (Navamsa) — marriage, dharma, the planet's true strength.",
          "D10 (Dashamsha) — career and public deeds; D7 children; D2 wealth.",
        ],
      },
      {
        heading: "Reading D1 and D9 together",
        body:
          "The classical method is to weigh the D1 first — it sets the baseline promise — then check the same planet in the D9. A planet weak in D1 but strong in D9 (called Vargottama when it keeps the same sign in both) recovers power with maturity; strong in D1 but afflicted in D9, its early promise needs protecting. Never read a varga alone: it refines the birth chart, it does not replace it.",
        points: [
          "Vargottama: same sign in D1 and D9 — a planet with deep roots.",
          "D9 strength matters most for marriage questions and late-life results.",
          "Use the D1–D12 buttons above your chart to flip between vargas.",
        ],
      },
    ],
  },
  {
    id: "transits",
    title: "12 · Transits (Gochara) & Sade Sati",
    level: "Advanced",
    minutes: 5,
    seeIn: { tab: "transit", label: "your transits & Sade Sati" },
    summary:
      "The birth chart is the promise; today's sky delivers it. How moving planets trigger your chart, and what the famous Sade Sati of Saturn really is.",
    sections: [
      {
        heading: "The sky keeps moving",
        body:
          "Transits (gochara) compare today's planetary positions with your birth chart. A transit matters when a slow planet — Saturn (~2.5 years per sign), Jupiter (~1 year), Rahu/Ketu (~1.5 years) — crosses a sensitive point: your Lagna, your Moon, or a natal planet. Fast planets (Sun, Mercury, Venus, the Moon) colour days and weeks; the slow ones mark chapters of life. In Vedic practice transits are read chiefly from the Moon sign.",
        points: [
          "Slow planets = life chapters; fast planets = the daily weather.",
          "Jupiter transiting your Moon or Lagna generally supports and expands.",
          "A transit can only deliver what the birth chart and dasha promise.",
        ],
      },
      {
        heading: "Sade Sati — Saturn's seven and a half years",
        body:
          "Sade Sati ('seven and a half') is Saturn's slow walk across the 12th, 1st and 2nd signs from your natal Moon — about 2.5 years per sign. It has a fearsome reputation, but classically it is a season of pruning: responsibilities pile up, comfort thins, and whatever is unsustainable gets restructured. Its middle phase (Saturn on the Moon itself) is usually the most demanding. The app's Transit tab shows your current Sade Sati status and phase.",
        visual: "sade-sati",
        points: [
          "Phase 1 (12th from Moon): expenses and loosening of old supports.",
          "Phase 2 (over the Moon): the core test — health, mind, duty.",
          "Phase 3 (2nd from Moon): rebuilding finances and family footing.",
        ],
      },
    ],
  },
  {
    id: "yogas",
    title: "13 · Yogas (Combinations)",
    level: "Pro",
    minutes: 5,
    seeIn: { tab: "predictions", label: "yogas in your chart" },
    summary:
      "Special planetary combinations that concentrate a particular result — for wealth, wisdom, power or challenge.",
    sections: [
      {
        heading: "What a yoga is",
        body:
          "A yoga is a specific arrangement of planets that produces a defined result greater than the parts. Thousands are catalogued. Some, like the Raja yogas, promise power and success; the Dhana yogas, wealth; the Pancha Mahapurusha yogas, greatness of character. Others, like Kemadruma, warn of struggle.",
      },
      {
        heading: "Examples",
        body:
          "Gaja Kesari (Jupiter in a kendra from the Moon) gives intelligence and repute. Budha-Aditya (Sun with Mercury) sharpens the mind. The five Mahapurusha yogas arise when Mars, Mercury, Jupiter, Venus or Saturn sits strong (own/exalted) in an angle. This app detects a curated set and explains why each forms.",
      },
      {
        heading: "Reading yogas in context",
        body:
          "A yoga is a promise, but its delivery depends on the strength of the planets involved and the dasha in which it activates. Never read a single yoga in isolation — always weigh it against the whole chart.",
      },
    ],
  },
  {
    id: "remedies-theory",
    title: "14 · The Theory of Remedies (Upaya)",
    level: "Pro",
    minutes: 4,
    seeIn: { tab: "remedies", label: "your remedies" },
    summary:
      "Why remedies exist, the families they fall into, and how to choose one wisely.",
    sections: [
      {
        heading: "Karma and free will",
        body:
          "Remedies rest on the idea that karma is not wholly fixed. Some karma (dridha, fixed) must play out; some (adridha, soft) can be modified by conscious effort. Remedies are that conscious effort — ways to strengthen a weak but helpful planet, or to pacify one causing difficulty, and above all to shift the mind that meets the karma.",
      },
      {
        heading: "The families of remedy",
        body:
          "Classical remedies fall into a few groups: Mantra (sacred sound tuned to a planet), Ratna (gemstones that amplify a planet's rays), Daan (charity in a planet's substances), Puja/Deity worship, and Vrata/Lifestyle (conduct aligned with the planet). The safest and most universally recommended are mantra, charity and right conduct.",
        points: [
          "Mantra — repetition of the planet's sound.",
          "Gemstone — amplifies; use only for a weak, benefic planet, and test first.",
          "Charity — give the planet's substances to those it signifies.",
          "Conduct — live the planet's virtues (the deepest remedy).",
        ],
      },
      {
        heading: "Choosing wisely",
        body:
          "The golden rule: strengthen a planet only when it is weak AND functionally benefic for your Lagna. Amplifying a planet that already causes trouble makes things worse. When in doubt, favour charity, service and mantra over gemstones — they carry no risk and address the mind, which is where astrology's real leverage lies. Treat all remedies as reflective self-work, not guarantees.",
      },
    ],
  },
  {
    id: "matchmaking",
    title: "15 · Ashtakoota Matchmaking",
    level: "Pro",
    minutes: 6,
    seeIn: { tab: "match", label: "the Marriage Match tool" },
    summary:
      "The classical 36-point compatibility system: what the eight kootas actually measure, how to read a score, and where the method's limits are.",
    sections: [
      {
        heading: "Eight tests, thirty-six points",
        body:
          "Ashtakoota ('eight factors') compares two charts through their Moon signs and nakshatras. Each koota tests one layer of the relationship and carries a different weight, from Varna (1 point, attitude and temperament hierarchy) up to Nadi (8 points, constitution and health of the line). The points sum to 36; tradition calls 18+ acceptable, 24+ good, and 28+ excellent.",
        visual: "kootas",
      },
      {
        heading: "The heavyweights: Nadi, Bhakoot, Gana",
        body:
          "The three largest kootas dominate the verdict. NADI (8) compares the couple's constitutional type — a shared nadi is the classical red flag (Nadi Dosha). BHAKOOT (7) checks the distance between Moon signs; certain pairs (6-8, 2-12, 5-9) strain emotional rhythm. GANA (6) matches temperament classes — deva, manushya, rakshasa. Because these three alone hold 21 of 36 points, a low total usually traces back to one of them, and classical texts also list specific cancellations that soften each dosha.",
        points: [
          "Nadi Dosha: same nadi — weightiest objection, with known cancellations.",
          "Bhakoot Dosha: 6-8, 2-12 or 5-9 Moon-sign pairs strain day-to-day rhythm.",
          "Gana mismatch: deva-rakshasa pairings need maturity on both sides.",
        ],
      },
      {
        heading: "Reading a score honestly",
        body:
          "A score is a screening, not a verdict. Two charts can score 30 and still struggle if both have afflicted 7th houses; a 17 with strong 7th lords, compatible Navamsas and mutual Venus-Moon harmony can thrive. After the kootas, a full match always checks Mangal Dosha on both sides, the 7th house and its lord in each D1 and D9, and the couple's dasha timing. Use the score to ask better questions — never to end the conversation.",
        points: [
          "Score bands: 18+ acceptable · 24+ good · 28+ excellent.",
          "Always cross-check: Mangal Dosha, 7th houses, D9, and dashas.",
          "The app's Marriage Match tab computes all eight kootas for two saved charts.",
        ],
      },
    ],
  },
];
