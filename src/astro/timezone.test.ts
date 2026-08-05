import { describe, it, expect } from "vitest";
import { zoneOffsetHours } from "./timezone";
import { CITIES, cityZone } from "../data/cities";

describe("zoneOffsetHours — modern offsets", () => {
  it("India Standard Time is +5.5", () => {
    expect(zoneOffsetHours("Asia/Kolkata", 2000, 1, 1, 12, 0)).toBe(5.5);
  });

  it("Nepal is +5.75", () => {
    expect(zoneOffsetHours("Asia/Kathmandu", 2000, 1, 1, 12, 0)).toBe(5.75);
  });

  it("resolves US Eastern DST vs standard time", () => {
    expect(zoneOffsetHours("America/New_York", 2021, 7, 1, 12, 0)).toBe(-4); // EDT
    expect(zoneOffsetHours("America/New_York", 2021, 1, 1, 12, 0)).toBe(-5); // EST
  });

  it("resolves UK summer (BST) vs winter (GMT)", () => {
    expect(zoneOffsetHours("Europe/London", 2021, 7, 1, 12, 0)).toBe(1); // BST
    expect(zoneOffsetHours("Europe/London", 2021, 1, 1, 12, 0)).toBe(0); // GMT
  });
});

describe("zoneOffsetHours — historical offsets", () => {
  it("applies India's 1942–1945 wartime +6:30 clock", () => {
    // A birth in mid-1943 in India used +06:30, not the modern +05:30.
    expect(zoneOffsetHours("Asia/Kolkata", 1943, 6, 1, 12, 0)).toBe(6.5);
    // Back to +05:30 well after the war.
    expect(zoneOffsetHours("Asia/Kolkata", 1960, 6, 1, 12, 0)).toBe(5.5);
  });

  it("handles pre-DST US dates (standard time only)", () => {
    // 1900: America/New_York ran on EST year-round.
    expect(zoneOffsetHours("America/New_York", 1900, 7, 1, 12, 0)).toBe(-5);
  });
});

describe("cityZone", () => {
  it("resolves single-zone countries from the country default", () => {
    const delhi = CITIES.find((c) => c.name === "New Delhi")!;
    expect(cityZone(delhi)).toBe("Asia/Kolkata");
  });

  it("uses the explicit zone for multi-zone countries", () => {
    const ny = CITIES.find((c) => c.name === "New York")!;
    const la = CITIES.find((c) => c.name === "Los Angeles")!;
    const hk = CITIES.find((c) => c.name === "Hong Kong")!;
    expect(cityZone(ny)).toBe("America/New_York");
    expect(cityZone(la)).toBe("America/Los_Angeles");
    expect(cityZone(hk)).toBe("Asia/Hong_Kong");
  });

  it("resolves a zone for every built-in city", () => {
    for (const c of CITIES) {
      const z = cityZone(c);
      expect(z, `${c.name}, ${c.country}`).not.toBeNull();
      // And the zone must be one the JS engine actually knows.
      expect(() =>
        new Intl.DateTimeFormat("en-US", { timeZone: z! }),
      ).not.toThrow();
    }
  });
});
