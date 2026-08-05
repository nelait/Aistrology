// Vastu Shastra teaching content, structured exactly like the astrology course
// (see ./lessons.ts). The rules taught here match the ones the app's Vastu
// analyser actually applies, so a lesson and the tool never disagree.

import type { Lesson } from "./lessons";

export const VASTU_LESSONS: Lesson[] = [
  {
    id: "vastu-what",
    title: "1 · What Vastu Shastra Is",
    level: "Beginner",
    minutes: 4,
    seeIn: { tab: "vastu", label: "your Vastu analysis" },
    summary:
      "The idea behind Vastu — buildings as a body of energy — and what it can and cannot claim to do.",
    sections: [
      {
        heading: "The science of dwelling",
        body:
          "Vastu Shastra is the classical Indian discipline of building and placement. Its premise is simple: a dwelling sits in a field of natural forces — sunlight, wind, heat, water flow, magnetism — and a building that cooperates with those forces is more comfortable and supportive to live in than one that fights them. Vastu encodes that cooperation as rules about direction, proportion and placement.",
      },
      {
        heading: "Where the rules come from",
        body:
          "Most Vastu rules trace back to observable climate logic in the Indian subcontinent. The kitchen belongs in the south-east because that is where the morning sun heats first, aiding cooking and hygiene before refrigeration. The north-east stays open and light because it receives gentle morning sun. Heavy storage goes south-west, the hottest and harshest quadrant. Learning the reasoning makes the rules easy to remember — and easy to apply sensibly.",
        points: [
          "Direction rules follow sun path, prevailing wind and heat load.",
          "Light, water and openness → north and east.",
          "Weight, storage and sleep → south and west.",
        ],
      },
      {
        heading: "An honest framing",
        body:
          "Treat Vastu as design guidance with cultural depth, not physical law. A well-placed kitchen will not guarantee prosperity, and a south-west entrance will not doom a household. This app scores a property against classical rules and suggests practical adjustments — use it to make better choices among real options, and never let a Vastu score override structural safety, budget or basic livability.",
      },
    ],
  },
  {
    id: "vastu-directions",
    title: "2 · The Eight Directions & Five Elements",
    level: "Beginner",
    minutes: 5,
    seeIn: { tab: "vastu", label: "the direction selectors" },
    summary:
      "The compass is Vastu's alphabet. Learn what each of the eight directions governs, its element and its ruling deity.",
    sections: [
      {
        heading: "Eight directions, four corners",
        body:
          "Vastu divides space into four cardinal directions (N, E, S, W) and four corners (NE, SE, SW, NW). Each carries an element and a presiding lord. The four corners do most of the work in practice: north-east (Ishanya, water) is the purest and should stay light and open; south-east (Agneya, fire) rules cooking and energy; south-west (Nairutya, earth) is the heaviest and most stable; north-west (Vayavya, air) governs movement and things that should not linger.",
        visual: "vastu-compass",
        points: [
          "NE — Ishanya, water: open, light, prayer, water source.",
          "SE — Agneya, fire: kitchen, electricals, heat.",
          "SW — Nairutya, earth: master bedroom, heavy storage.",
          "NW — Vayavya, air: bathrooms, guest rooms, garage, movement.",
        ],
      },
      {
        heading: "The five elements (Pancha Bhuta)",
        body:
          "Behind the directions sit the five elements: earth (prithvi), water (jal), fire (agni), air (vayu) and space (akasha). Good Vastu keeps each element in the zone that belongs to it — fire in the south-east, water in the north-east — and avoids collisions such as a water tank in the fire corner or a kitchen in the water corner. Most 'doshas' you will meet are simply an element in the wrong zone.",
      },
    ],
  },
  {
    id: "vastu-zones",
    title: "3 · The Nine Zones & the Brahmasthan",
    level: "Beginner",
    minutes: 4,
    seeIn: { tab: "vastu", label: "your Vastu analysis" },
    summary:
      "How a plot is divided into a 3×3 grid, and why the centre square must stay empty.",
    sections: [
      {
        heading: "The Vastu Purusha Mandala",
        body:
          "Classical Vastu overlays a grid on the plot — the Vastu Purusha Mandala, the figure of the cosmic being lying across the site. In everyday practice a simple 3×3 grid is enough: eight zones around the edge, matching the eight directions, and one square in the middle. Each zone has a preferred use, and the analysis in this app effectively asks which zone each of your rooms occupies.",
        visual: "vastu-zones",
      },
      {
        heading: "The Brahmasthan — keep the centre free",
        body:
          "The central square is the Brahmasthan, the property's still point. The strongest classical instruction is to keep it open and unburdened: no toilet, no heavy pillar, no staircase, no clutter. A courtyard, atrium, open living space or simply an uncrowded floor is ideal. If your centre is occupied, the standard mitigations are to lighten it — remove storage, improve light, and avoid running plumbing through it.",
        points: [
          "Ideal Brahmasthan: open, well-lit, uncluttered.",
          "Avoid: toilets, staircases, heavy machinery or storage at the centre.",
          "Can't change it? Lighten and de-clutter, and keep it clean.",
        ],
      },
    ],
  },
  {
    id: "vastu-rooms",
    title: "4 · Room by Room — the Placement Rules",
    level: "Beginner",
    minutes: 6,
    seeIn: { tab: "vastu", label: "your room-by-room analysis" },
    summary:
      "The core placement table this app scores against: kitchen, bedroom, bathroom, water, stairs, pooja room, garden and garage.",
    sections: [
      {
        heading: "The ideal placements",
        body:
          "These are the placements the app treats as ideal, each following from its element. Getting three or four of them right already lifts a property's score substantially — no house satisfies every rule, so prioritise the kitchen, master bedroom and water source first.",
        visual: "vastu-rooms",
        points: [
          "Kitchen → SE (fire corner); NW is the usual acceptable alternative.",
          "Master bedroom → SW (earth: stability, rest, authority).",
          "Bathroom / toilet → NW or W (air corner — waste should move on).",
          "Water source, borewell, tank → NE (purest corner).",
          "Staircase → SW, S or W (weight belongs in the heavy quadrant).",
          "Pooja room / altar → NE or E (face east while praying).",
          "Garden / open space → N, NE or E (let light in).",
          "Garage / parking → NW or SE.",
        ],
      },
      {
        heading: "Why the kitchen and bedroom matter most",
        body:
          "The kitchen carries fire, the most disruptive element to misplace: a kitchen in the north-east (water corner) is the classical worst case, and one in the south-west is also discouraged. The master bedroom in the south-west grounds the household's decision-maker in the heaviest, most stable quadrant; a master bedroom in the north-east or south-east tends to be flagged for restlessness. When you run the app's analysis, these two placements move the score more than any others.",
      },
      {
        heading: "Reading your results honestly",
        body:
          "Each room in the app's report gets a severity — good, moderate or bad — plus a specific remedy when it is not ideal. Two moderates are usually fine; a house that is 'bad' on kitchen, bedroom and water at once is worth thinking hard about. Remember that a rented flat or an existing home is rarely re-plannable: the remedies exist precisely because most people cannot move a kitchen.",
      },
    ],
  },
  {
    id: "vastu-plot",
    title: "5 · Plot, Shape, Slope & Entrance",
    level: "Advanced",
    minutes: 5,
    seeIn: { tab: "vastu", label: "the plot & entrance questions" },
    summary:
      "Before rooms come the land and the door: shape, level, facing direction and where the entrance sits within the face.",
    sections: [
      {
        heading: "Shape and slope",
        body:
          "A square plot is the classical ideal, followed by a rectangle with a modest length-to-width ratio. L-shaped and irregular plots are considered weaker because a zone is effectively missing — an L-shaped plot cut at the north-east is treated more seriously than one cut at the south-west. For slope, land that falls toward the north, east or north-east is favoured (water drains through the auspicious corners), while a fall toward the south-west is the least desirable.",
        visual: "vastu-slope",
        points: [
          "Shape: square > rectangle > L-shaped > irregular.",
          "Slope: down toward N / NE / E is best; toward SW is worst.",
          "A missing NE corner is the most significant shape defect.",
        ],
      },
      {
        heading: "Facing and the entrance",
        body:
          "The facing direction is where the main entrance looks out — traditionally north and east facing are most favoured because they receive gentler light, though every direction has workable entrance positions. Vastu then asks a second, finer question: WHERE in that face the door sits. A north-facing house is best entered from the northern half nearer the north-east, not tucked into the north-west end. This is why the app asks for facing direction and entrance position separately.",
        points: [
          "Facing = which way the main door looks out.",
          "Entrance position = where along that face the door actually sits.",
          "Prefer the half of the face closer to N or E; avoid the far SW end.",
        ],
      },
    ],
  },
  {
    id: "vastu-doshas",
    title: "6 · Vastu Doshas & Practical Remedies",
    level: "Advanced",
    minutes: 5,
    seeIn: { tab: "vastu", label: "your remedies list" },
    summary:
      "The common defects, what they actually mean, and what can realistically be done without rebuilding.",
    sections: [
      {
        heading: "The common doshas",
        body:
          "A Vastu dosha is simply an element in the wrong zone. The classics most often flagged: a kitchen in the north-east or a toilet there (fire or waste in the water corner); a burdened Brahmasthan; a missing or cut north-east corner; a master bedroom in the north-east; heavy storage or a water tank in the wrong quadrant; and a slope falling toward the south-west. Each has a severity, and none is a verdict on the household.",
      },
      {
        heading: "Remedies that actually work",
        body:
          "Structural correction is best where feasible — moving a stove within the kitchen toward the south-east wall, shifting a bed so the head lies south, opening up a cluttered centre. Where structure cannot change, classical practice uses lighter measures: keep problem areas scrupulously clean and closed, add light to weak zones, keep the north-east open and uncluttered, use salt bowls and ventilation in bathrooms, and place mirrors or lamps to lift dark corners. The app suggests a specific remedy for every non-ideal placement it finds.",
        points: [
          "First choice: adjust within the room (stove wall, bed direction, storage).",
          "Second: light, ventilation, cleanliness, closed bathroom doors.",
          "Symbolic remedies (crystals, salt, lamps) support the above — not replace them.",
        ],
      },
      {
        heading: "Proportion, not panic",
        body:
          "No property scores perfectly, and the classical texts themselves assume compromise. Treat a low score as a list of things to improve over time, ranked by severity, rather than a reason to abandon a home you otherwise love. If a property is right on price, location, light and safety, a moderate Vastu score is a poor reason to walk away.",
      },
    ],
  },
  {
    id: "vastu-jyotisha",
    title: "7 · Vastu Meets Jyotisha",
    level: "Pro",
    minutes: 5,
    seeIn: { tab: "vastu", label: "your astro-Vastu factors" },
    summary:
      "How your birth chart personalises a property assessment — the layer that makes this app's Vastu analysis specific to you.",
    sections: [
      {
        heading: "Your Lagna suggests a facing",
        body:
          "Generic Vastu says north and east facing are good for everyone. Jyotisha refines that: each Lagna sign has directions that suit it better, derived from the sign's element and its lord's natural direction. A fire-sign Lagna is comfortable with south and east exposure; a water-sign Lagna leans north and north-east. The app compares your property's facing direction against the auspicious directions for your Lagna and scores the match — which is why two people can get different verdicts on the same house.",
      },
      {
        heading: "The 4th house — the property house",
        body:
          "In Jyotisha the 4th house governs home, land, vehicles and inner contentment, and its lord's condition describes your relationship with property. A strong, well-placed 4th lord suggests homes that suit you and settle easily; a weak or afflicted one suggests more friction — delays, repairs, or several moves before the right fit. The app reads your 4th house lord as part of its astro-Vastu factors.",
        points: [
          "4th house = home, land, vehicles, comfort.",
          "4th lord strong → property matters flow more easily.",
          "4th lord afflicted → expect diligence: inspect, document, don't rush.",
        ],
      },
      {
        heading: "Mars, the land significator",
        body:
          "Mars is the Bhoomi Karaka — the natural significator of land and property. Its strength and placement colour how you acquire and hold real estate: well-placed Mars supports decisive purchases and successful construction, while an afflicted Mars counsels caution with disputes, boundaries and paperwork. Together, Lagna direction, the 4th lord and Mars form the astrological half of the app's Vastu score, which it combines with the room-by-room analysis into a single suitability rating.",
      },
    ],
  },
];
