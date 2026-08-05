import { describe, it, expect } from "vitest";
import { muhurtaForDate, findMuhurta, MUHURTA_ACTIVITIES, type MuhurtaLocation } from "./muhurta";

const DELHI: MuhurtaLocation = { latitude: 28.6139, longitude: 77.209, tzOffsetHours: 5.5, label: "New Delhi" };
const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d));
const toMin = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));

/** Analytic half-day angle: cos H = (sin h0 − sin φ sin δ) / (cos φ cos δ). */
function analyticDayLengthMin(latDeg: number, decDeg: number, h0 = -0.833): number {
  const r = (x: number) => (x * Math.PI) / 180;
  const c = (Math.sin(r(h0)) - Math.sin(r(latDeg)) * Math.sin(r(decDeg))) /
            (Math.cos(r(latDeg)) * Math.cos(r(decDeg)));
  return (2 * (Math.acos(Math.max(-1, Math.min(1, c))) * 180) / Math.PI / 15) * 60;
}

// ── Tithi validated against published syzygy instants ──────────────────────
// Reference (timeanddate.com): New Moon 2026-08-12 17:37 UTC (= 23:07 IST),
// Full Moon 2026-08-28 04:18 UTC (= 09:48 IST). Delhi sunrise precedes both,
// so those dates must read the tithi that *ends* at the syzygy, and the next
// day must have rolled over into the following paksha.
describe("muhurta — tithi against known new/full moons", () => {
  it("reads Amavasya at sunrise on the 2026-08-12 new-moon day", () => {
    const d = muhurtaForDate(utc(2026, 8, 12), DELHI);
    expect(d.panchanga.tithiNum).toBe(30);
    expect(d.panchanga.tithiName).toBe("Amavasya");
    expect(d.panchanga.paksha).toBe("Krishna");
  });

  it("rolls into Shukla Pratipada the day after the new moon", () => {
    const d = muhurtaForDate(utc(2026, 8, 13), DELHI);
    expect(d.panchanga.tithiNum).toBe(1);
    expect(d.panchanga.tithiName).toBe("Shukla Pratipada");
  });

  it("reads Purnima at sunrise on the 2026-08-28 full-moon day", () => {
    const d = muhurtaForDate(utc(2026, 8, 28), DELHI);
    expect(d.panchanga.tithiNum).toBe(15);
    expect(d.panchanga.tithiName).toBe("Purnima");
    expect(d.panchanga.paksha).toBe("Shukla");
  });

  it("rolls into Krishna Pratipada the day after the full moon", () => {
    const d = muhurtaForDate(utc(2026, 8, 29), DELHI);
    expect(d.panchanga.tithiNum).toBe(16);
    expect(d.panchanga.tithiName).toBe("Krishna Pratipada");
  });

  it("keeps the Moon in the Sun's nakshatra region at new moon", () => {
    // At conjunction the Moon shares the Sun's sidereal longitude; in mid-August
    // the sidereal Sun is in Cancer, so Pushya (Cancer) is the expected region.
    expect(muhurtaForDate(utc(2026, 8, 12), DELHI).panchanga.nakshatra).toBe("Pushya");
  });
});

// ── Sunrise/sunset against first principles (not a third-party API) ────────
describe("muhurta — sunrise/sunset geometry", () => {
  it("matches the analytic day length at Delhi on the June solstice", () => {
    const d = muhurtaForDate(utc(2026, 6, 21), DELHI);
    const got = toMin(d.sunset!) - toMin(d.sunrise!);
    expect(got).toBeCloseTo(analyticDayLengthMin(28.6139, 23.4358), -0.5); // within ~1 min
    expect(Math.abs(got - analyticDayLengthMin(28.6139, 23.4358))).toBeLessThan(2);
  });

  it("gives ~12h07m at the equator on the equinox (12h + refraction)", () => {
    const d = muhurtaForDate(utc(2026, 3, 20), { latitude: 0, longitude: 0, tzOffsetHours: 0 });
    const got = toMin(d.sunset!) - toMin(d.sunrise!);
    expect(Math.abs(got - analyticDayLengthMin(0, 0))).toBeLessThan(2);
  });

  it("puts solar noon midway between sunrise and sunset", () => {
    const d = muhurtaForDate(utc(2026, 6, 21), DELHI);
    const mid = (toMin(d.sunrise!) + toMin(d.sunset!)) / 2;
    // Delhi (77.209E) against the IST meridian (82.5E) → noon ~21 min late.
    expect(mid).toBeGreaterThan(12 * 60 + 15);
    expect(mid).toBeLessThan(12 * 60 + 30);
  });

  it("never emits an inverted daylight span, even with a mismatched offset", () => {
    // Hand-entered coordinates with a badly wrong UTC offset used to leave the
    // sun already up at local midnight, so the first sunset found belonged to
    // the previous day and every derived window came out end-before-start.
    for (const tz of [5.5, 0, -8, 12, -12]) {
      const d = muhurtaForDate(utc(2026, 8, 3), { latitude: 28.6139, longitude: 77.209, tzOffsetHours: tz });
      expect(d.sunrise).not.toBeNull();
      const rk = d.inauspicious.find((w) => w.name === "Rahu Kaal")!;
      // Windows may run past local midnight, so compare on an unwrapped scale.
      const span = (a: string, b: string) => (toMin(b) - toMin(a) + 1440) % 1440;
      expect(span(rk.from, rk.to)).toBeGreaterThan(0);
      expect(span(rk.from, rk.to)).toBeLessThan(200); // one eighth of a day
    }
  });

  it("returns null sunrise/sunset inside the polar circle in midsummer", () => {
    const d = muhurtaForDate(utc(2026, 6, 21), { latitude: 78.2, longitude: 15.6, tzOffsetHours: 1 });
    expect(d.sunrise).toBeNull();
    expect(d.sunset).toBeNull();
    expect(d.auspicious).toHaveLength(0);
    expect(d.inauspicious).toHaveLength(0);
  });

  it("handles the southern hemisphere (Sydney days are short in June, long in December)", () => {
    const SYD: MuhurtaLocation = { latitude: -33.8688, longitude: 151.2093, tzOffsetHours: 10 };
    const jun = muhurtaForDate(utc(2026, 6, 21), SYD);
    const dec = muhurtaForDate(utc(2026, 12, 21), SYD);
    expect(toMin(jun.sunset!) - toMin(jun.sunrise!)).toBeLessThan(toMin(dec.sunset!) - toMin(dec.sunrise!));
  });
});

// ── Classical window conventions ───────────────────────────────────────────
describe("muhurta — auspicious/inauspicious windows", () => {
  const day = muhurtaForDate(utc(2026, 8, 3), DELHI); // a Monday

  it("places Rahu Kaal in the 2nd of 8 day-parts on a Monday", () => {
    const rk = day.inauspicious.find((w) => w.name === "Rahu Kaal")!;
    const rise = toMin(day.sunrise!), set = toMin(day.sunset!);
    const part = (set - rise) / 8;
    // Windows are emitted as HH:MM, so allow a minute of rounding.
    expect(Math.abs(toMin(rk.from) - (rise + part))).toBeLessThanOrEqual(1);
    expect(Math.abs(toMin(rk.to) - (rise + 2 * part))).toBeLessThanOrEqual(1);
  });

  it("centres Abhijit Muhurta on solar noon", () => {
    const ab = day.auspicious.find((w) => w.name === "Abhijit Muhurta")!;
    const noon = (toMin(day.sunrise!) + toMin(day.sunset!)) / 2;
    const mid = (toMin(ab.from) + toMin(ab.to)) / 2;
    expect(Math.abs(mid - noon)).toBeLessThan(2);
  });

  it("puts Brahma Muhurta 96–48 minutes before sunrise", () => {
    const bm = day.auspicious.find((w) => w.name === "Brahma Muhurta")!;
    const rise = toMin(day.sunrise!);
    expect(rise - toMin(bm.from)).toBeCloseTo(96, 0);
    expect(rise - toMin(bm.to)).toBeCloseTo(48, 0);
  });

  it("emits well-formed, non-inverted windows every day of a 60-day sweep", () => {
    for (const d of findMuhurta(utc(2026, 1, 1), 60, DELHI)) {
      for (const w of [...d.auspicious, ...d.inauspicious]) {
        expect(w.from).toMatch(/^\d{2}:\d{2}$/);
        expect(w.to).toMatch(/^\d{2}:\d{2}$/);
        if (w.name !== "Brahma Muhurta") expect(toMin(w.to)).toBeGreaterThan(toMin(w.from));
      }
      expect(toMin(d.sunset!)).toBeGreaterThan(toMin(d.sunrise!));
    }
  });

  it("never overlaps Rahu Kaal, Yamaganda and Gulika (distinct day-parts)", () => {
    for (const d of findMuhurta(utc(2026, 1, 1), 14, DELHI)) {
      const starts = d.inauspicious.map((w) => w.from);
      expect(new Set(starts).size).toBe(starts.length);
    }
  });
});

// ── Rahu Kaal against published values, and DST correctness ───────────────
describe("muhurta — Rahu Kaal", () => {
  it("matches published Rahu Kaal for Delhi on Mon 2026-08-03 (07:24–09:05)", () => {
    // drikpanchang / prokerala / mpanchang all give 7:24 AM – 9:05 AM.
    const rk = muhurtaForDate(utc(2026, 8, 3), DELHI).inauspicious.find((w) => w.name === "Rahu Kaal")!;
    expect(Math.abs(toMin(rk.from) - toMin("07:24"))).toBeLessThanOrEqual(1);
    expect(Math.abs(toMin(rk.to) - toMin("09:05"))).toBeLessThanOrEqual(1);
  });

  it("uses the correct day-part for every weekday", () => {
    // Classical order, Sunday→Saturday: 8th, 2nd, 7th, 5th, 6th, 4th, 3rd part.
    const expected = [8, 2, 7, 5, 6, 4, 3];
    for (const d of findMuhurta(utc(2026, 8, 2), 7, DELHI)) { // 2026-08-02 is a Sunday
      const rk = d.inauspicious.find((w) => w.name === "Rahu Kaal")!;
      const rise = toMin(d.sunrise!), part = (toMin(d.sunset!) - rise) / 8;
      const idx = Math.round((toMin(rk.from) - rise) / part) + 1;
      const wd = new Date(`${d.date}T00:00:00Z`).getUTCDay();
      expect(idx).toBe(expected[wd]);
    }
  });

  it("resolves the offset per date across a DST transition when a zone is given", () => {
    // US DST begins 2026-03-08. A range starting 2026-03-01 must not carry the
    // pre-transition offset forward — that would shift every window by an hour.
    const LA = { latitude: 34.0522, longitude: -118.2437, tzOffsetHours: -8, zone: "America/Los_Angeles" };
    const days = findMuhurta(utc(2026, 3, 1), 14, LA);
    const before = days.find((d) => d.date === "2026-03-07")!;
    const after = days.find((d) => d.date === "2026-03-09")!;
    // Sunrise jumps forward ~1h on the clock across the spring-forward switch.
    const jump = toMin(after.sunrise!) - toMin(before.sunrise!);
    expect(jump).toBeGreaterThan(50);
    expect(jump).toBeLessThan(70);
  });

  it("keeps `date` and `weekday` in agreement when the date is read as UTC", () => {
    // Guards the display contract: `date` is a UTC-pinned civil date, so any
    // formatter must pass timeZone:"UTC". Rendering it in a browser west of UTC
    // without that shows the previous day — which would put one weekday's Rahu
    // Kaal under another weekday's heading.
    for (const d of findMuhurta(utc(2026, 10, 29), 10, DELHI)) {
      const rendered = new Date(`${d.date}T00:00:00Z`)
        .toLocaleDateString("en-GB", { weekday: "long", timeZone: "UTC" });
      expect(rendered).toBe(d.weekday);
    }
  });

  it("honours a fixed offset when no zone is supplied (no silent DST guessing)", () => {
    const fixed = { latitude: 34.0522, longitude: -118.2437, tzOffsetHours: -8 };
    const days = findMuhurta(utc(2026, 3, 1), 14, fixed);
    const before = days.find((d) => d.date === "2026-03-07")!;
    const after = days.find((d) => d.date === "2026-03-09")!;
    expect(Math.abs(toMin(after.sunrise!) - toMin(before.sunrise!))).toBeLessThan(10);
  });
});

// ── Panchanga continuity & ratings ─────────────────────────────────────────
describe("muhurta — panchanga continuity and ratings", () => {
  it("advances the tithi by 0, 1 or 2 per day (skips/repeats are legitimate)", () => {
    const days = findMuhurta(utc(2026, 1, 1), 90, DELHI);
    for (let i = 1; i < days.length; i++) {
      const step = (days[i].panchanga.tithiNum - days[i - 1].panchanga.tithiNum + 30) % 30;
      expect(step).toBeLessThanOrEqual(2);
    }
  });

  it("keeps every panchanga field in range", () => {
    for (const d of findMuhurta(utc(2026, 4, 1), 60, DELHI)) {
      expect(d.panchanga.tithiNum).toBeGreaterThanOrEqual(1);
      expect(d.panchanga.tithiNum).toBeLessThanOrEqual(30);
      expect(d.panchanga.nakshatraIndex).toBeGreaterThanOrEqual(0);
      expect(d.panchanga.nakshatraIndex).toBeLessThan(27);
      expect(d.panchanga.nakshatra).toBeTruthy();
      expect(d.panchanga.yoga).toBeTruthy();
      expect(d.weekday).toBe(d.panchanga.weekday);
    }
  });

  it("matches the weekday to the calendar date", () => {
    const d = muhurtaForDate(utc(2026, 8, 3), DELHI);
    expect(d.weekday).toBe("Monday"); // 2026-08-03 is a Monday
    expect(d.date).toBe("2026-08-03");
  });

  it("produces a spread of ratings rather than collapsing to one bucket", () => {
    const days = findMuhurta(utc(2026, 1, 1), 120, DELHI);
    const seen = new Set(days.map((d) => d.rating));
    expect(seen.size).toBeGreaterThanOrEqual(3);
    for (const d of days) expect(d.reasons.length).toBeGreaterThan(0);
  });

  it("rates every supported activity without error", () => {
    for (const a of MUHURTA_ACTIVITIES) {
      const days = findMuhurta(utc(2026, 5, 1), 20, DELHI, a);
      expect(days).toHaveLength(20);
      for (const d of days) expect(["excellent", "good", "average", "avoid"]).toContain(d.rating);
    }
  });

  it("returns exactly the requested number of consecutive dates", () => {
    const days = findMuhurta(utc(2026, 2, 26), 6, DELHI); // spans a month boundary
    expect(days.map((d) => d.date)).toEqual([
      "2026-02-26", "2026-02-27", "2026-02-28",
      "2026-03-01", "2026-03-02", "2026-03-03",
    ]);
  });
});
