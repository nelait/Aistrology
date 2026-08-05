// The interpretive knowledge base: what each graha, rashi, bhava and nakshatra
// signifies. This is the raw material the prediction engine weaves together.
// Sources are the classical significations taught in standard Jyotisha texts
// (Brihat Parashara Hora Shastra, Phaladeepika, Saravali) rendered in plain
// modern language.

import { PlanetName } from "../astro/constants";

export interface PlanetSignification {
  planet: PlanetName;
  title: string; // e.g. "The Soul", "The Mind"
  karaka: string; // what it primarily signifies (karakatva)
  keywords: string[];
  positive: string; // when strong / well-placed
  negative: string; // when weak / afflicted
  body: string; // body parts / health
  dayLordOf?: string; // weekday
}

export const PLANET_SIGNIFICATIONS: Record<PlanetName, PlanetSignification> = {
  Sun: {
    planet: "Sun",
    title: "The Soul (Atmakaraka)",
    karaka: "Self, soul, vitality, father, authority, government, ego, health",
    keywords: ["identity", "willpower", "leadership", "father", "status", "vitality"],
    positive:
      "Confidence, strong constitution, leadership, honesty, recognition from authority and a dignified, principled nature.",
    negative:
      "Ego conflicts, trouble with authority or father, low vitality, arrogance or a bruised sense of self-worth.",
    body: "Heart, spine, bones, eyes (right eye in men), general vitality.",
    dayLordOf: "Sunday",
  },
  Moon: {
    planet: "Moon",
    title: "The Mind (Manas)",
    karaka: "Mind, emotions, mother, comfort, public, fluids, nourishment",
    keywords: ["emotion", "mother", "mind", "intuition", "home", "receptivity"],
    positive:
      "Emotional stability, warmth, popularity, a caring nature, imagination and good rapport with the public.",
    negative:
      "Mood swings, anxiety, emotional dependence, restlessness or a troubled relationship with the mother.",
    body: "Mind, chest, breasts, stomach, bodily fluids, lymphatic system.",
    dayLordOf: "Monday",
  },
  Mars: {
    planet: "Mars",
    title: "The Commander (Senapati)",
    karaka: "Energy, courage, siblings, land, drive, discipline, conflict",
    keywords: ["energy", "courage", "action", "brothers", "property", "anger"],
    positive:
      "Courage, initiative, technical/athletic skill, protective strength and the drive to finish what is begun.",
    negative:
      "Impulsiveness, anger, accidents, conflict, injuries or friction with siblings.",
    body: "Muscles, blood, bone marrow, forehead, reproductive energy.",
    dayLordOf: "Tuesday",
  },
  Mercury: {
    planet: "Mercury",
    title: "The Prince (Kumara)",
    karaka: "Intellect, speech, commerce, learning, skill, nerves",
    keywords: ["intellect", "communication", "trade", "wit", "analysis", "youth"],
    positive:
      "Quick intelligence, eloquence, business sense, adaptability, humour and skill with language or numbers.",
    negative:
      "Nervousness, indecision, dishonesty, scattered thinking or speech/skin/nerve issues.",
    body: "Skin, nervous system, hands, tongue, lungs.",
    dayLordOf: "Wednesday",
  },
  Jupiter: {
    planet: "Jupiter",
    title: "The Teacher (Guru)",
    karaka: "Wisdom, wealth, children, teachers, dharma, fortune, expansion",
    keywords: ["wisdom", "fortune", "children", "faith", "growth", "generosity"],
    positive:
      "Wisdom, optimism, good fortune, ethics, generosity, respect, and support from mentors and children.",
    negative:
      "Over-indulgence, complacency, misplaced faith, weight/liver issues or difficulty with children.",
    body: "Liver, fat, thighs, arterial system, growth.",
    dayLordOf: "Thursday",
  },
  Venus: {
    planet: "Venus",
    title: "The Minister (Amatya)",
    karaka: "Love, marriage, beauty, art, luxury, vehicles, pleasure",
    keywords: ["love", "beauty", "art", "romance", "comfort", "harmony"],
    positive:
      "Charm, artistic talent, romance, comforts, refined taste, harmony in relationships and material ease.",
    negative:
      "Over-indulgence, relationship troubles, vanity, extravagance or reproductive/kidney issues.",
    body: "Reproductive system, kidneys, face, throat, semen/ova.",
    dayLordOf: "Friday",
  },
  Saturn: {
    planet: "Saturn",
    title: "The Servant / Judge (Shani)",
    karaka: "Discipline, time, longevity, labour, karma, delay, detachment",
    keywords: ["discipline", "patience", "hard work", "karma", "delay", "structure"],
    positive:
      "Discipline, endurance, responsibility, longevity, and lasting success built slowly through honest effort.",
    negative:
      "Delays, obstacles, fear, isolation, chronic ailments or heavy burdens and pessimism.",
    body: "Bones, teeth, joints, knees, nerves, chronic conditions.",
    dayLordOf: "Saturday",
  },
  Rahu: {
    planet: "Rahu",
    title: "The Shadow Head (Rahu)",
    karaka: "Ambition, obsession, foreign lands, illusion, technology, sudden gains",
    keywords: ["ambition", "desire", "foreign", "innovation", "illusion", "disruption"],
    positive:
      "Worldly ambition, originality, mastery of the unconventional, sudden rise and success in foreign or cutting-edge fields.",
    negative:
      "Obsession, confusion, deception, addictions, anxiety and unexpected upheaval.",
    body: "Nervous disorders, mysterious ailments, skin, poisoning.",
  },
  Ketu: {
    planet: "Ketu",
    title: "The Shadow Tail (Ketu)",
    karaka: "Detachment, liberation, past-life skill, spirituality, loss, mysticism",
    keywords: ["detachment", "spirituality", "intuition", "loss", "moksha", "mystery"],
    positive:
      "Spiritual insight, intuition, research ability, healing gifts and effortless past-life mastery of a subject.",
    negative:
      "Detachment to the point of loss, confusion about direction, sudden separations or elusive health issues.",
    body: "Immune system, subtle ailments, spine, mysterious conditions.",
  },
};

// --- Bhavas (houses) ---
export interface HouseSignification {
  house: number; // 1..12
  name: string; // Sanskrit bhava name
  meaning: string;
  keywords: string[];
  bodyPart: string;
  type: "Kendra" | "Trikona" | "Dusthana" | "Upachaya" | "Maraka" | "Other";
}

export const HOUSE_SIGNIFICATIONS: HouseSignification[] = [
  { house: 1, name: "Tanu Bhava", meaning: "Self, body, personality, health, appearance and the overall direction of life.", keywords: ["self", "body", "vitality", "temperament"], bodyPart: "Head, overall constitution", type: "Kendra" },
  { house: 2, name: "Dhana Bhava", meaning: "Wealth, family, speech, food, accumulated resources and early upbringing.", keywords: ["money", "family", "speech", "values"], bodyPart: "Face, right eye, mouth, teeth", type: "Maraka" },
  { house: 3, name: "Sahaja Bhava", meaning: "Courage, effort, younger siblings, short journeys, skills and communication.", keywords: ["courage", "siblings", "effort", "hobbies"], bodyPart: "Arms, shoulders, hands, ears", type: "Upachaya" },
  { house: 4, name: "Sukha Bhava", meaning: "Home, mother, comforts, property, vehicles, education and inner happiness.", keywords: ["home", "mother", "property", "peace"], bodyPart: "Chest, heart, lungs", type: "Kendra" },
  { house: 5, name: "Putra Bhava", meaning: "Children, intelligence, creativity, romance, speculation and past-life merit (purva punya).", keywords: ["children", "creativity", "romance", "intellect"], bodyPart: "Stomach, upper abdomen", type: "Trikona" },
  { house: 6, name: "Ripu Bhava", meaning: "Enemies, disease, debts, obstacles, service, competition and daily work.", keywords: ["health", "enemies", "debt", "service"], bodyPart: "Lower abdomen, intestines, kidneys", type: "Dusthana" },
  { house: 7, name: "Kalatra Bhava", meaning: "Marriage, spouse, partnerships, business relations and public dealings.", keywords: ["marriage", "partnership", "spouse", "trade"], bodyPart: "Pelvis, reproductive organs", type: "Kendra" },
  { house: 8, name: "Ayur Bhava", meaning: "Longevity, sudden events, transformation, inheritance, occult and hidden matters.", keywords: ["transformation", "longevity", "inheritance", "secrets"], bodyPart: "Genitals, excretory organs", type: "Dusthana" },
  { house: 9, name: "Dharma Bhava", meaning: "Fortune, dharma, higher learning, guru, father, long journeys and spirituality.", keywords: ["luck", "dharma", "guru", "philosophy"], bodyPart: "Hips, thighs", type: "Trikona" },
  { house: 10, name: "Karma Bhava", meaning: "Career, status, authority, reputation and one's action in the world.", keywords: ["career", "status", "authority", "fame"], bodyPart: "Knees, joints", type: "Kendra" },
  { house: 11, name: "Labha Bhava", meaning: "Gains, income, aspirations, friends, elder siblings and fulfilment of desires.", keywords: ["gains", "income", "friends", "goals"], bodyPart: "Calves, ankles, left ear", type: "Upachaya" },
  { house: 12, name: "Vyaya Bhava", meaning: "Loss, expenditure, foreign lands, isolation, liberation (moksha) and the subconscious.", keywords: ["loss", "expense", "foreign", "moksha"], bodyPart: "Feet, left eye", type: "Dusthana" },
];

// --- Compact interpretation phrases ---
// Planet-in-sign: keyed by planet, indexed 0..11 by sign.
export const PLANET_IN_SIGN: Partial<Record<PlanetName, string[]>> = {
  Sun: [
    "exalted and radiant — bold, pioneering leadership and strong will.",
    "steady, values comfort, status through patience; can be fixed in ego.",
    "curious, communicative authority; leadership through intellect.",
    "emotionally attached to identity; strong ties to home and mother.",
    "own sign — natural authority, dignity, generosity and command.",
    "analytical, service-minded, perfectionist leadership.",
    "debilitated — identity found through others; learns balance and diplomacy.",
    "intense, secretive willpower; transformative, research-minded.",
    "principled, philosophical, dharmic and optimistic self.",
    "ambitious, disciplined, status-driven and hard-working.",
    "unconventional, humanitarian, independent-minded authority.",
    "compassionate, imaginative, spiritually inclined identity.",
  ],
  Moon: [
    "impulsive, pioneering emotions; quick-tempered but courageous mind.",
    "exalted — calm, sensual, steady and content emotional nature.",
    "restless, chatty, intellectually curious and adaptable mind.",
    "own sign — nurturing, receptive, deeply feeling and imaginative.",
    "warm, proud, dramatic and generous emotions.",
    "practical, analytical, sometimes worrying mind.",
    "sociable, harmony-seeking, relationship-oriented feelings.",
    "debilitated — intense, secretive, emotionally deep; heals through transformation.",
    "optimistic, freedom-loving, philosophical emotions.",
    "reserved, ambitious, self-controlled feelings.",
    "detached, humanitarian, unconventional emotional nature.",
    "compassionate, dreamy, psychically sensitive mind.",
  ],
  Mars: [
    "own sign — direct, courageous, energetic and competitive.",
    "determined, sensual, stubborn drive; works for security.",
    "versatile, argumentative, mentally energetic.",
    "debilitated — scattered energy, emotional temper; learns focus.",
    "bold, commanding, dramatic and passionate action.",
    "precise, critical, technically skilful energy.",
    "energy directed through partnership; can bring conflict in relations.",
    "own sign — intense, strategic, penetrating and resolute.",
    "adventurous, idealistic, energetic and freedom-seeking.",
    "exalted — disciplined, ambitious, highly effective executive drive.",
    "innovative, rebellious, cause-driven energy.",
    "compassionate yet moody drive; energy tied to emotion.",
  ],
  Mercury: [
    "quick, blunt, pioneering intellect; acts on ideas fast.",
    "practical, deliberate, resourceful thinking.",
    "own sign — versatile, witty, communicative and curious.",
    "emotional, retentive memory; intuitive thinking.",
    "confident, creative, persuasive expression.",
    "exalted & own sign — precise, analytical, articulate and skilful.",
    "diplomatic, balanced, refined communication.",
    "probing, secretive, investigative intellect.",
    "philosophical, big-picture (sometimes careless with detail) thinking.",
    "structured, methodical, serious intellect.",
    "inventive, original, systems-thinking mind.",
    "debilitated — imaginative but diffuse; thinks in images and feeling.",
  ],
  Jupiter: [
    "bold, principled, pioneering wisdom.",
    "practical wisdom; values comfort and resources.",
    "curious but scattered faith; learns discernment.",
    "exalted — compassionate, wise, deeply fortunate and nurturing.",
    "generous, dignified, dharmic and creative.",
    "detailed, service-minded (can over-analyse) growth.",
    "just, harmonious, relationship-blessing wisdom.",
    "profound, occult, research-oriented faith.",
    "own sign — philosophical, ethical, expansive and lucky.",
    "debilitated — practical scepticism; wisdom learned through limitation.",
    "humanitarian, reformist, broad-minded growth.",
    "own sign — devotional, compassionate, spiritually rich and fortunate.",
  ],
  Venus: [
    "impulsive, passionate, romantic and spontaneous in love.",
    "own sign — sensual, loyal, comfort- and beauty-loving.",
    "flirtatious, versatile, intellectually attracted.",
    "tender, nurturing, emotionally devoted love.",
    "warm, loyal, dramatic and generous affections.",
    "debilitated — modest, discerning (over-critical) in love; refines standards.",
    "own sign — charming, diplomatic, art-loving and partnership-oriented.",
    "intense, magnetic, all-or-nothing passion.",
    "idealistic, adventurous, freedom-loving affections.",
    "reserved, committed, status-aware love.",
    "unconventional, friendly, detached affections.",
    "exalted — compassionate, romantic, devotional and artistically gifted.",
  ],
  Saturn: [
    "debilitated — self-doubt turned to discipline; learns patience.",
    "steady, security-focused, enduring effort.",
    "structured thinking; disciplined communication.",
    "emotional restraint; learns comfort through responsibility.",
    "disciplined leadership; authority earned slowly.",
    "meticulous, dutiful, service-oriented labour.",
    "exalted — just, responsible, socially respected and fair.",
    "resilient, controlled, deeply strategic endurance.",
    "principled, dutiful, ethically serious discipline.",
    "own sign — ambitious, patient, career-building and authoritative.",
    "own sign — humanitarian, systematic, reform-minded discipline.",
    "compassionate duty; disciplined imagination.",
  ],
  Rahu: [
    "bold ambition for identity and pioneering ventures.",
    "hunger for wealth, comfort and status.",
    "obsession with information, media and communication.",
    "restless emotional cravings; foreign homes.",
    "desire for power, fame and recognition.",
    "ambition in service, health and problem-solving.",
    "intense desires through partnerships and the public.",
    "fascination with the occult, research and taboo.",
    "unconventional beliefs; foreign philosophies.",
    "relentless worldly ambition and status-climbing.",
    "innovation, technology and humanitarian scale.",
    "spiritual longing mixed with escapism.",
  ],
  Ketu: [
    "detachment from self-assertion; spiritual independence.",
    "indifference to wealth; non-material values.",
    "intuitive rather than logical communication.",
    "emotional detachment; inner spiritual home.",
    "detachment from power and applause.",
    "healing gifts; detachment from routine and enemies.",
    "karmic lessons through partnership.",
    "natural mystic; occult and research ability.",
    "innate wisdom; detachment from dogma.",
    "detachment from ambition and status.",
    "insight into systems; detachment from gains.",
    "strong pull toward liberation and surrender.",
  ],
};

// Planet-in-house (bhava) phrases: keyed by planet, indexed 0..11 for houses 1..12.
export const PLANET_IN_HOUSE: Partial<Record<PlanetName, string[]>> = {
  Sun: [
    "a strong, self-driven personality and a wish to lead and be seen.",
    "self-worth tied to wealth and family; authoritative speech.",
    "courage and initiative; a rise through personal effort.",
    "focus on home, property and reputation; ego linked to mother/roots.",
    "creative authority, bright children and speculative confidence.",
    "victory over enemies and disease through effort; service leadership.",
    "identity worked out through partnership; strong-willed spouse or public ego-tests.",
    "interest in the hidden; transformation, inheritance and longevity themes.",
    "fortune, dharma and a strong connection to father and higher learning.",
    "a powerful placement for career, status, fame and authority.",
    "steady gains, influential friends and fulfilled ambitions.",
    "expenditure, spiritual seeking or life/work in distant lands.",
  ],
  Moon: [
    "an emotionally expressive, changeable and personable nature.",
    "emotional security through family and wealth; sweet speech.",
    "an emotionally courageous, creative and communicative mind.",
    "exalted domain of comfort — a happy home and close bond with mother.",
    "emotional creativity, love of children and a romantic heart.",
    "sensitivity to health and daily stress; caring service.",
    "emotional fulfilment through relationship and the public.",
    "deep, private emotions; interest in mysteries and the psyche.",
    "an optimistic, faithful, fortune-seeking mind.",
    "public-facing career; emotional investment in status.",
    "gains through the public and network of friends.",
    "a contemplative, private mind drawn to solitude or foreign shores.",
  ],
  Mars: [
    "a bold, energetic, sometimes impatient personality.",
    "aggressive drive for wealth; assertive, blunt speech.",
    "excellent for courage, initiative and sibling support.",
    "drive applied to home and property; possible domestic friction.",
    "passionate creativity and competitive intelligence.",
    "a fighter's edge — victory over enemies, debts and disease.",
    "passion and drive in partnership; guard against relationship conflict.",
    "intensity around transformation, surgery and hidden resources.",
    "a crusading, energetic pursuit of dharma and ideals.",
    "a driven, ambitious, action-oriented career.",
    "energetic pursuit of gains and bold goals.",
    "expenditure of energy; guard against hidden anger or injury abroad.",
  ],
  Mercury: [
    "a clever, communicative, youthful and adaptable personality.",
    "skill with money, language and family matters.",
    "writing, skill and communicative courage.",
    "an intellectual home life and love of learning.",
    "sharp intelligence, wit and creative/speculative skill.",
    "analytical problem-solving in work and health.",
    "clever, businesslike partnerships and negotiation.",
    "research ability and interest in the hidden and technical.",
    "a philosophical, articulate, publishing/teaching mind.",
    "intelligent, communicative and commercially able career.",
    "gains through commerce, networks and ideas.",
    "a reflective, imaginative or research-oriented intellect.",
  ],
  Jupiter: [
    "an optimistic, wise, generous and respected personality.",
    "wealth, good family values and nourishing speech.",
    "wisdom applied to effort; supportive siblings.",
    "a fortunate, comfortable, well-educated home.",
    "excellent for children, wisdom and good fortune (a favoured placement).",
    "guard against complacency; benefic help with enemies and debts.",
    "a fortunate marriage and a wise, principled partner.",
    "interest in occult wisdom; inheritance and good longevity.",
    "the best placement — fortune, dharma, guru's grace and higher learning.",
    "an ethical, respected career and rise through knowledge.",
    "abundant gains, good friends and fulfilled hopes.",
    "spiritual wealth, charity and liberation-oriented wisdom.",
  ],
  Venus: [
    "charm, grace, beauty and a pleasure-loving personality.",
    "wealth, refined tastes and sweet, artistic speech.",
    "artistic skill and pleasant relations with siblings.",
    "domestic comfort, vehicles, luxury and a happy home.",
    "romance, artistic creativity and love of children.",
    "guard against indulgence; harmony restored through service.",
    "a strong placement for marriage, love and partnership.",
    "pleasures around the hidden; possible gains through spouse/legacy.",
    "refined philosophy, love of travel, art and culture.",
    "success in artistic, luxury or relationship-based careers.",
    "gains through art, women, luxury and social networks.",
    "bed-comforts, private pleasures and love in distant places.",
  ],
  Saturn: [
    "a serious, responsible, disciplined (sometimes reserved) personality.",
    "wealth built slowly; measured, careful speech.",
    "disciplined effort and endurance; delayed but earned courage.",
    "responsibility around home and mother; comfort comes late.",
    "cautious creativity; children/education after effort.",
    "a strong placement — endurance defeats enemies, disease and debt.",
    "commitment and duty in marriage; a mature or older partner.",
    "longevity, endurance and interest in the deep and hidden.",
    "dharma through discipline; fortune earned through perseverance.",
    "a hallmark of a hard-won, lasting, authoritative career.",
    "steady, reliable gains accumulated over time.",
    "detachment, solitude, foreign residence or a spiritual retreat.",
  ],
  Rahu: [
    "an unconventional, ambitious, magnetic personality.",
    "unusual sources of wealth; persuasive, sometimes exaggerated speech.",
    "bold ambition, daring and success through effort.",
    "restlessness at home; foreign or unconventional dwellings.",
    "unconventional creativity; care needed with children/speculation.",
    "a powerful placement — Rahu excels at defeating enemies and rivals.",
    "intense, unconventional or foreign partnerships.",
    "obsession with the occult; sudden events and hidden gains/losses.",
    "unorthodox beliefs; foreign or non-traditional philosophy.",
    "great worldly ambition — a strong (if unconventional) career rise.",
    "one of Rahu's best houses — large, sudden and unexpected gains.",
    "expenditure, foreign life, spiritual confusion or liberation.",
  ],
  Ketu: [
    "a detached, introspective, spiritually inclined personality.",
    "detachment from wealth and family; unconventional values.",
    "intuitive courage; detachment from ordinary ambition.",
    "emotional detachment from home; inner search for peace.",
    "intuitive intelligence; a karmic approach to children.",
    "excellent for defeating enemies and healing chronic disease.",
    "karmic, on-and-off or spiritually tinged partnerships.",
    "natural occult ability, research and interest in longevity.",
    "innate wisdom and a pull toward mysticism over dogma.",
    "detachment from status; work approached as duty.",
    "unexpected gains balanced by detachment from them.",
    "a strong placement for moksha, meditation and liberation.",
  ],
};
