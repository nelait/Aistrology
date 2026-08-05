// Remedies (Upaya) per graha, each with the classical *justification* — the
// reasoning that ties the remedy to the planet it is meant to strengthen or
// pacify. Remedies in Jyotisha fall into a few families: mantra (sound),
// ratna (gemstone), daan (charity), and vrata/lifestyle (conduct).
//
// These are presented as traditional guidance for reflection and self-work, not
// as medical, financial or psychological advice.

import { PlanetName } from "../astro/constants";

export interface Remedy {
  type: "Mantra" | "Gemstone" | "Charity" | "Lifestyle" | "Deity";
  action: string;
  justification: string;
}

export interface PlanetRemedies {
  planet: PlanetName;
  gemstone: string;
  metal: string;
  color: string;
  day: string;
  seedMantra: string; // beeja mantra
  mantraCount: number; // traditional japa count
  deity: string;
  remedies: Remedy[];
  caution: string;
}

export const REMEDIES: Record<PlanetName, PlanetRemedies> = {
  Sun: {
    planet: "Sun",
    gemstone: "Ruby (Manikya)",
    metal: "Gold / Copper",
    color: "Red, orange, saffron",
    day: "Sunday",
    seedMantra: "ॐ ह्रां ह्रीं ह्रौं सः सूर्याय नमः",
    mantraCount: 7000,
    deity: "Surya / Lord Shiva / Rama",
    remedies: [
      { type: "Mantra", action: "Recite the Aditya Hridayam or the Surya beeja mantra at sunrise facing east.", justification: "The Sun rules the soul and vitality; sound offered at its own hour (dawn) and direction (east) resonates with its natural strength and steadies the sense of self." },
      { type: "Lifestyle", action: "Offer water (Arghya) to the rising Sun in a copper vessel.", justification: "Copper is the Sun's metal and water offered at dawn is a classical act of surrender to the Atmakaraka, humbling the ego the Sun governs." },
      { type: "Charity", action: "Donate wheat, jaggery or copper on Sundays; respect and serve your father and elders.", justification: "The Sun signifies father and authority; honouring them and giving in the Sun's substances repays the karma the planet represents." },
      { type: "Gemstone", action: "Wear a natural ruby in gold on the ring finger, Sunday morning — only if the Sun is a functional benefic for your Lagna.", justification: "A ruby amplifies the Sun's rays; it strengthens a weak but well-disposed Sun, but must be avoided when the Sun is a malefic ruler for the chart." },
    ],
    caution: "Strengthen the Sun only when it is weak yet benefic. If the Sun already causes ego or authority problems, prefer humility, service and mantra over a gemstone.",
  },
  Moon: {
    planet: "Moon",
    gemstone: "Pearl (Moti)",
    metal: "Silver",
    color: "White, cream, silver",
    day: "Monday",
    seedMantra: "ॐ श्रां श्रीं श्रौं सः चन्द्राय नमः",
    mantraCount: 11000,
    deity: "Chandra / Parvati / Shiva (Somnath)",
    remedies: [
      { type: "Mantra", action: "Chant the Chandra beeja mantra on Mondays, ideally on a waxing Moon.", justification: "The Moon rules the mind; rhythmic sound calms mental restlessness, and a waxing Moon lends its own increasing strength to the practice." },
      { type: "Charity", action: "Offer milk, rice or white cloth; serve and honour your mother.", justification: "The Moon is the karaka of the mother and of nourishment; caring for her and giving nourishing white substances directly feeds the Moon's significations." },
      { type: "Lifestyle", action: "Keep water near you, stay hydrated, and spend calm time near rivers or the sea.", justification: "The Moon governs water and emotional flow; contact with water and steady routine settle an agitated lunar mind." },
      { type: "Gemstone", action: "Wear a natural pearl in silver on the little finger, Monday evening, when the Moon is weak.", justification: "A pearl steadies and cools the emotions, reinforcing a Moon weakened by waning phase, affliction or a difficult sign." },
    ],
    caution: "A waning or afflicted Moon indicates the mind needs support; combine remedies with rest, routine and emotional care rather than relying on the gemstone alone.",
  },
  Mars: {
    planet: "Mars",
    gemstone: "Red Coral (Moonga)",
    metal: "Copper / Gold",
    color: "Red, coral",
    day: "Tuesday",
    seedMantra: "ॐ क्रां क्रीं क्रौं सः भौमाय नमः",
    mantraCount: 10000,
    deity: "Hanuman / Kartikeya / Narasimha",
    remedies: [
      { type: "Deity", action: "Worship Hanuman; read the Hanuman Chalisa on Tuesdays.", justification: "Hanuman embodies disciplined, devotional strength — the ideal channel for Mars's raw energy, converting aggression into courage and service." },
      { type: "Lifestyle", action: "Take up regular vigorous exercise or a martial/physical discipline.", justification: "Mars is pure energy; giving it a healthy outlet prevents the pent-up force from surfacing as anger, accidents or conflict." },
      { type: "Charity", action: "Donate red lentils (masoor), red cloth or land-related help on Tuesdays.", justification: "Red lentils and red items carry Mars's colour and heat; giving them channels its intensity outward as generosity." },
      { type: "Gemstone", action: "Wear red coral in copper or gold on the ring finger, Tuesday morning, when Mars is weak but benefic.", justification: "Coral fortifies courage, drive and immunity; it supports a weak, well-placed Mars but is avoided when Mars already fuels temper or strife." },
    ],
    caution: "A strong-but-afflicted Mars needs discipline, not amplification. Use exercise, patience practices and Hanuman worship before considering coral.",
  },
  Mercury: {
    planet: "Mercury",
    gemstone: "Emerald (Panna)",
    metal: "Gold / Silver",
    color: "Green",
    day: "Wednesday",
    seedMantra: "ॐ ब्रां ब्रीं ब्रौं सः बुधाय नमः",
    mantraCount: 9000,
    deity: "Vishnu / Ganesha",
    remedies: [
      { type: "Mantra", action: "Chant the Budha beeja mantra or the Vishnu Sahasranama on Wednesdays.", justification: "Mercury governs speech and intellect; refined, repeated sound sharpens the very faculties the planet rules." },
      { type: "Charity", action: "Donate green gram (moong), green cloth or books; sponsor a child's education.", justification: "Mercury signifies learning and youth; giving green items and supporting education nourishes its core significations." },
      { type: "Lifestyle", action: "Feed grass or green fodder to cows; practise clear, honest, kind speech.", justification: "Mercury rules communication and the nervous system; truthful speech and the calming act of feeding cows steady an anxious, scattered mind." },
      { type: "Gemstone", action: "Wear a natural emerald in gold on the little finger, Wednesday morning, when Mercury is weak.", justification: "Emerald enhances intellect, memory and communication, reinforcing a weak but benefic Mercury." },
    ],
    caution: "Because Mercury takes on the nature of the planets it joins, judge its condition carefully before strengthening it.",
  },
  Jupiter: {
    planet: "Jupiter",
    gemstone: "Yellow Sapphire (Pukhraj)",
    metal: "Gold",
    color: "Yellow, gold",
    day: "Thursday",
    seedMantra: "ॐ ग्रां ग्रीं ग्रौं सः गुरवे नमः",
    mantraCount: 19000,
    deity: "Brihaspati / Vishnu / Dakshinamurthy",
    remedies: [
      { type: "Mantra", action: "Chant the Guru beeja mantra or the Vishnu/Brihaspati stotra on Thursdays.", justification: "Jupiter is the Guru, karaka of wisdom and dharma; devotional sound aligns the mind with the higher knowledge Jupiter bestows." },
      { type: "Charity", action: "Donate turmeric, chana dal, yellow cloth, or gold; support teachers, temples and scriptures.", justification: "Jupiter signifies knowledge, teachers and dharma; giving yellow items and supporting learning repays and strengthens its blessings." },
      { type: "Lifestyle", action: "Respect gurus and elders, study scripture, and act with generosity and ethics.", justification: "Jupiter rewards righteous conduct; living its values (wisdom, generosity, faith) is itself the most direct remedy." },
      { type: "Gemstone", action: "Wear a yellow sapphire in gold on the index finger, Thursday morning, when Jupiter is weak or benefic.", justification: "Yellow sapphire magnifies Jupiter's fortune, wisdom and optimism — one of the most auspicious stones when the planet is well-disposed." },
    ],
    caution: "Yellow sapphire is fast-acting; test-wear before committing, and avoid strengthening Jupiter if it is a strong functional malefic for the Lagna.",
  },
  Venus: {
    planet: "Venus",
    gemstone: "Diamond (Heera) / White Sapphire",
    metal: "Silver / Platinum",
    color: "White, pastel, pink",
    day: "Friday",
    seedMantra: "ॐ द्रां द्रीं द्रौं सः शुक्राय नमः",
    mantraCount: 16000,
    deity: "Lakshmi / Shukra",
    remedies: [
      { type: "Mantra", action: "Chant the Shukra beeja mantra or the Sri Suktam on Fridays.", justification: "Venus rules love, beauty and abundance; invoking Lakshmi through sound draws the harmony and prosperity Venus governs." },
      { type: "Charity", action: "Donate white sweets, sugar, white cloth or perfume; honour and respect women.", justification: "Venus signifies women, refinement and pleasure; giving its sweet, fragrant substances and respecting women strengthen its significations." },
      { type: "Lifestyle", action: "Cultivate art, music and beauty; keep relationships harmonious and surroundings clean.", justification: "Venus thrives on beauty and harmony; consciously creating them in life aligns you with the planet's nature." },
      { type: "Gemstone", action: "Wear a diamond or white sapphire in silver/platinum on the middle or little finger, Friday morning, when Venus is weak.", justification: "Diamond amplifies love, luxury, artistry and comfort, supporting a weak but benefic Venus." },
    ],
    caution: "Venus rules indulgence as well as refinement; pair its remedies with moderation so comfort does not slide into excess.",
  },
  Saturn: {
    planet: "Saturn",
    gemstone: "Blue Sapphire (Neelam)",
    metal: "Iron / Steel",
    color: "Dark blue, black",
    day: "Saturday",
    seedMantra: "ॐ प्रां प्रीं प्रौं सः शनैश्चराय नमः",
    mantraCount: 23000,
    deity: "Shani / Hanuman / Bhairava",
    remedies: [
      { type: "Deity", action: "Worship Shani and Hanuman; read the Shani stotra or Hanuman Chalisa on Saturdays.", justification: "Saturn tests and rewards righteous effort; Hanuman is traditionally said to shield devotees from Shani's harshness, and honest devotion softens Saturn's discipline." },
      { type: "Charity", action: "Serve the poor, elderly, labourers and the disabled; donate black sesame, iron, oil or black cloth.", justification: "Saturn is the karaka of the downtrodden and of labour; selfless service to them is the single most effective Saturn remedy in classical texts." },
      { type: "Lifestyle", action: "Be disciplined, punctual, patient and honest; accept responsibility without complaint.", justification: "Saturn rewards structure and integrity; simply living its virtues turns its pressure into lasting achievement." },
      { type: "Gemstone", action: "Wear a blue sapphire in iron/silver on the middle finger — only after careful testing — when Saturn is weak but benefic.", justification: "Neelam is the fastest-acting gemstone; it can powerfully steady a weak, benefic Saturn, but reacts strongly and must be trial-worn first." },
    ],
    caution: "Blue sapphire is the most reactive of gems — never wear it without a trial period. For most people, service and discipline are the safer, surer Saturn remedies.",
  },
  Rahu: {
    planet: "Rahu",
    gemstone: "Hessonite (Gomed)",
    metal: "Silver / Ashtadhatu",
    color: "Smoky, grey, ultraviolet",
    day: "Saturday (with Saturn)",
    seedMantra: "ॐ भ्रां भ्रीं भ्रौं सः राहवे नमः",
    mantraCount: 18000,
    deity: "Durga / Bhairava / Saraswati",
    remedies: [
      { type: "Deity", action: "Worship Durga or Bhairava; chant the Durga mantra to steady Rahu's illusions.", justification: "Rahu is the shadow of desire and confusion; the protective, clarifying energy of Durga cuts through the delusion Rahu creates." },
      { type: "Charity", action: "Donate mustard oil, blankets, or feed the poor; give to lepers and outcasts.", justification: "Rahu signifies the marginalised and the foreign; serving those on society's edges settles its unquiet, boundary-crossing nature." },
      { type: "Lifestyle", action: "Avoid intoxicants, shortcuts and deception; ground yourself with routine and meditation.", justification: "Rahu amplifies craving and illusion; sobriety, honesty and grounding practices deny it the chaos it feeds on." },
      { type: "Gemstone", action: "Wear hessonite in silver on the middle finger, Saturday, only under expert guidance.", justification: "Gomed can focus Rahu's scattered ambition into achievement, but Rahu is unpredictable and the stone should be worn cautiously." },
    ],
    caution: "Rahu's remedies are best aimed at clarity and grounding rather than amplifying ambition; gemstones for the nodes should be approached with special care.",
  },
  Ketu: {
    planet: "Ketu",
    gemstone: "Cat's Eye (Lehsunia)",
    metal: "Silver / Ashtadhatu",
    color: "Smoky, brown, multicolour",
    day: "Tuesday (with Mars)",
    seedMantra: "ॐ स्रां स्रीं स्रौं सः केतवे नमः",
    mantraCount: 17000,
    deity: "Ganesha / Bhairava",
    remedies: [
      { type: "Deity", action: "Worship Ganesha to remove obstacles and give direction to Ketu's confusion.", justification: "Ketu is the headless significator of detachment and loss of direction; Ganesha, remover of obstacles, supplies the focus Ketu lacks." },
      { type: "Charity", action: "Feed dogs, donate multicoloured or brown cloth, and support spiritual seekers.", justification: "Ketu signifies dogs, renunciates and the spiritual; caring for them honours Ketu's detached, otherworldly nature." },
      { type: "Lifestyle", action: "Take up meditation, mantra and selfless spiritual practice.", justification: "Ketu's deepest desire is liberation (moksha); channelling it into genuine spiritual practice turns aimless detachment into insight." },
      { type: "Gemstone", action: "Wear cat's eye in silver, Tuesday or Wednesday, only under expert guidance.", justification: "Lehsunia can stabilise Ketu's sudden losses and sharpen intuition, but like all nodal stones must be worn with care." },
    ],
    caution: "Ketu responds best to spiritual, not material, remedies; its lessons are usually about letting go rather than acquiring.",
  },
};
