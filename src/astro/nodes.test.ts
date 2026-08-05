import { describe, it, expect } from "vitest";
import { meanNodeLongitude, trueNodeLongitude, ketuLongitude } from "./nodes";
import { norm180, norm360 } from "./math";

const J2000 = 2451545.0;

describe("mean node", () => {
  it("keeps Ketu exactly 180° from Rahu (mean)", () => {
    for (let jd = J2000; jd < J2000 + 2000; jd += 137) {
      const sep = norm360(meanNodeLongitude(jd) - ketuLongitude(jd));
      expect(Math.abs(sep - 180)).toBeLessThan(1e-9);
    }
  });

  it("drifts retrograde ~19.3° per year", () => {
    const drift = norm180(
      meanNodeLongitude(J2000 + 365.25) - meanNodeLongitude(J2000),
    );
    expect(drift).toBeLessThan(-18);
    expect(drift).toBeGreaterThan(-21);
  });
});

describe("true node — physical properties", () => {
  // Sample across several oscillation cycles.
  const samples: number[] = [];
  for (let jd = J2000; jd < J2000 + 3000; jd += 3) {
    samples.push(norm180(trueNodeLongitude(jd) - meanNodeLongitude(jd)));
  }

  it("oscillates within ~1.9° of the mean node", () => {
    const maxDev = Math.max(...samples.map(Math.abs));
    expect(maxDev).toBeGreaterThan(1.3); // dominant term amplitude ~1.5°
    expect(maxDev).toBeLessThan(1.9);
  });

  it("is centred on the mean node (near-zero average deviation)", () => {
    const avg = samples.reduce((s, x) => s + x, 0) / samples.length;
    expect(Math.abs(avg)).toBeLessThan(0.1);
  });

  it("repeats with the ~173-day nodal oscillation period", () => {
    // Robust to small fast terms: the deviation at time t should correlate
    // strongly with itself one fundamental period (~173.3 d) later, and
    // anti-correlate half a period later. Sampled at 1-day steps here.
    const dev: number[] = [];
    for (let jd = J2000; jd < J2000 + 3000; jd += 1) {
      dev.push(norm180(trueNodeLongitude(jd) - meanNodeLongitude(jd)));
    }
    const corrAtLag = (lag: number) => {
      const n = dev.length - lag;
      const a = dev.slice(0, n);
      const b = dev.slice(lag, lag + n);
      const ma = a.reduce((s, x) => s + x, 0) / n;
      const mb = b.reduce((s, x) => s + x, 0) / n;
      let num = 0, da = 0, db = 0;
      for (let i = 0; i < n; i++) {
        const xa = a[i] - ma;
        const xb = b[i] - mb;
        num += xa * xb;
        da += xa * xa;
        db += xb * xb;
      }
      return num / Math.sqrt(da * db);
    };
    expect(corrAtLag(173)).toBeGreaterThan(0.8); // one period later: repeats
    expect(corrAtLag(87)).toBeLessThan(-0.6); // half period later: inverted
  });

  it("still drifts retrograde over a year like the mean node", () => {
    const drift = norm180(
      trueNodeLongitude(J2000 + 365.25) - trueNodeLongitude(J2000),
    );
    expect(drift).toBeLessThan(-16);
    expect(drift).toBeGreaterThan(-23);
  });
});
