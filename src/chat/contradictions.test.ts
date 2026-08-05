import { describe, it, expect } from "vitest";
import { computeChart } from "../astro/engine";
import { BirthData } from "../astro/types";
import { findChartContradictions } from "./contradictions";

// Reference chart (engine suite): Ascendant Pisces, Sun in Sagittarius,
// Moon in Aquarius, Mars in Scorpio.
const PROFILE: BirthData = {
  name: "Reference", year: 1990, month: 1, day: 1, hour: 12, minute: 0, second: 0,
  tzOffsetHours: 5.5, latitude: 28.6139, longitude: 77.209, placeLabel: "New Delhi, India",
};
const chart = computeChart(PROFILE);

describe("findChartContradictions", () => {
  it("returns nothing for a faithful reply", () => {
    const reply = "Your ascendant is Pisces. The Sun is in Sagittarius and your Moon is in Aquarius.";
    expect(findChartContradictions(reply, chart)).toEqual([]);
  });

  it("flags a wrong ascendant claim", () => {
    const c = findChartContradictions("Your Lagna is Leo, which makes you bold.", chart);
    expect(c).toContainEqual({ subject: "Ascendant", claimed: "Leo", actual: "Pisces" });
  });

  it("flags a wrong planet-in-sign claim", () => {
    const c = findChartContradictions("Your Sun is in Aries, giving you drive.", chart);
    expect(c).toContainEqual({ subject: "Sun", claimed: "Aries", actual: "Sagittarius" });
  });

  it("catches several contradictions in one reply", () => {
    const reply = "Your ascendant is Leo. The Sun is in Aries and Mars is in Gemini.";
    const c = findChartContradictions(reply, chart);
    expect(c).toContainEqual({ subject: "Ascendant", claimed: "Leo", actual: "Pisces" });
    expect(c).toContainEqual({ subject: "Sun", claimed: "Aries", actual: "Sagittarius" });
    expect(c).toContainEqual({ subject: "Mars", claimed: "Gemini", actual: "Scorpio" });
  });

  it("does not flag a correct placement even when other prose is present", () => {
    const reply = "With the Moon in Aquarius, you value independence and original thinking.";
    expect(findChartContradictions(reply, chart)).toEqual([]);
  });

  it("de-duplicates a claim repeated across the reply", () => {
    const reply = "Your Sun is in Aries. Later: because the Sun sits in Aries, you are assertive.";
    const c = findChartContradictions(reply, chart);
    expect(c.filter((x) => x.subject === "Sun" && x.claimed === "Aries")).toHaveLength(1);
  });
});
