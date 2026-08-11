import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Guards against the two mobile bug *classes* found in the responsiveness
 * audit (see docs/mobile-responsive.md), at their source.
 *
 * These are stylesheet assertions, not layout assertions, and that is
 * deliberate: jsdom has no layout engine — `getBoundingClientRect()` returns
 * zeros — so no test in this suite can measure that something overflowed a
 * 375px viewport. Only a real browser can, and that is what caught these in the
 * first place. What a source check *can* do is stop the same mistake being
 * reintroduced, in milliseconds and with no new dependency.
 */

const CSS = readFileSync(
  fileURLToPath(new URL("./styles.css", import.meta.url)),
  "utf8",
);

/** Strip comments, then split into (selector, body) pairs. Nested at-rules are
 *  flattened, which is fine — we only ever ask about declarations. */
function rules(css: string): { selector: string; body: string }[] {
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const out: { selector: string; body: string }[] = [];
  for (const m of stripped.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    out.push({ selector: m[1].trim(), body: m[2] });
  }
  return out;
}

/** The media block that lifts every form control to 16px on phones. */
function phoneFontOverride(css: string): string | null {
  const m = css.match(/@media\s*\(\s*max-width:\s*640px\s*\)\s*\{([\s\S]*?)\}\s*\}/);
  return m ? m[1] : null;
}

describe("stylesheet — mobile guards", () => {
  it("lifts form controls to 16px at phone widths", () => {
    const block = phoneFontOverride(CSS);
    expect(block, "the ≤640px form-control override is missing").not.toBeNull();
    expect(block).toMatch(/input\s*,\s*select\s*,\s*textarea/);
    expect(block).toMatch(/font-size:\s*16px\s*!important/);
  });

  it("no form control is left under 16px without that override", () => {
    // Mobile Safari zooms the page on focus below 16px and never zooms back
    // out. The override above neutralises this for phones; this assertion
    // exists so that if the override is ever removed or narrowed, the 20-odd
    // rules it protects are named out loud rather than silently regressing.
    const offenders = rules(CSS)
      .filter((r) => /\b(input|select|textarea)\b/.test(r.selector))
      .map((r) => ({ r, m: r.body.match(/font-size:\s*([\d.]+)px/) }))
      .filter((x) => x.m && Number(x.m[1]) < 16)
      .map((x) => `${x.r.selector.split(",")[0].trim()} (${x.m![1]}px)`);

    if (offenders.length > 0) {
      expect(
        phoneFontOverride(CSS),
        `${offenders.length} form-control rules are under 16px and nothing lifts ` +
          `them on phones: ${offenders.slice(0, 5).join(", ")}…`,
      ).not.toBeNull();
    }
  });

  it("single-column grids use minmax(0, 1fr), not a bare 1fr", () => {
    // `1fr` === `minmax(auto, 1fr)`, and `auto` as a minimum is min-content —
    // so a grid collapsed to one column still grows past the viewport if a
    // child is intrinsically wide (a nowrap table, a long unbroken string).
    // That is exactly how the Kundli tab came to scroll sideways at 375px.
    const responsive = CSS.matchAll(
      /@media\s*\(\s*max-width:[^)]*\)\s*\{([\s\S]*?)\n\}/g,
    );
    const offenders: string[] = [];
    for (const block of responsive) {
      for (const r of rules(block[1])) {
        if (/grid-template-columns:\s*1fr\s*;/.test(r.body)) {
          offenders.push(r.selector.split(",")[0].trim());
        }
      }
    }
    expect(offenders, `bare 1fr in a max-width block: ${offenders.join(", ")}`)
      .toEqual([]);
  });

  it("viewport-height math has a dynamic-viewport form", () => {
    // On iOS Safari and Chrome Android `100vh` is the *large* viewport height —
    // it ignores the URL bar that is actually on screen — so the bottom of a
    // 100vh-sized panel (the chat input row) sits under the browser chrome.
    // Every calc(100vh - …) must be followed by a dvh equivalent.
    const vh = (CSS.match(/calc\(100vh\b/g) ?? []).length;
    const dvh = (CSS.match(/calc\(100dvh\b/g) ?? []).length;
    expect(dvh, `${vh} calc(100vh …) uses but only ${dvh} dvh fallbacks`).toBe(vh);
  });

  it("no auto-fill grid demands more width than a 320px phone has", () => {
    // A 320px-wide device (iPhone SE 1st gen) leaves ~288px inside the page
    // padding, so a minmax() minimum above that overflows its container.
    const tooWide: string[] = [];
    for (const r of rules(CSS)) {
      for (const m of r.body.matchAll(/minmax\(\s*(\d+)px/g)) {
        if (Number(m[1]) > 288) tooWide.push(`${r.selector.split(",")[0].trim()} (${m[1]}px)`);
      }
    }
    expect(tooWide, `minmax minimums wider than a 320px phone: ${tooWide.join(", ")}`)
      .toEqual([]);
  });
});
