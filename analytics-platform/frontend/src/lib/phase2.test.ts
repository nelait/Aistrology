import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseCidrList, policyWarnings, validateCidr } from "./cidr";
import { buildDistributions, parseWeights } from "./distributions";
import { driftLabel, driftTone, psiStatus } from "./drift";
import { CUSTOM_HTML_SANDBOX, customHtmlSrcdoc, hostAllowed, validateIframeUrl } from "./embed";
import { computeSignature, curlExample, pythonExample, shellQuote, signatureHeaderValue } from "./hookSignature";
import { diffCounts, diffSummary, flattenDiff, formatDiffValue, isBreakingChange } from "./schemaDiff";
import { fromApiWidget, normalizeSpec, toApiSpec } from "./dashboard";
import type { DashboardSpec, SchemaDiff } from "./types";

const DIFF: SchemaDiff = {
  identical: false,
  added_entities: ["refunds"],
  removed_entities: [],
  entities: [
    {
      name: "orders",
      added_fields: [
        { name: "coupon", type: "string", nullable: true },
        { name: "channel", type: "string", nullable: false },
      ],
      removed_fields: [{ name: "legacy_id", type: "integer", nullable: true }],
      retyped_fields: [{ field: "amount", from_type: "integer", to_type: "number" }],
      changed_fields: [
        { field: "status", attribute: "enum", from: ["paid", "refunded", "void"], to: ["paid", "refunded"] },
        { field: "note", attribute: "nullable", from: false, to: true },
        { field: "email", attribute: "nullable", from: true, to: false },
        { field: "price", attribute: "maximum", from: null, to: 500 },
      ],
    },
  ],
  breaking: true,
  summary: [],
};

describe("schema diff rendering", () => {
  it("flattens entities and fields in a stable order with breaking flags", () => {
    const rows = flattenDiff(DIFF);
    expect(rows.map((r) => [r.kind, r.field ?? r.entity, r.breaking])).toEqual([
      ["entity_added", "refunds", false],
      ["field_added", "coupon", false],
      ["field_added", "channel", true], // new required field
      ["field_removed", "legacy_id", true],
      ["retyped", "amount", true],
      ["changed", "status", true], // narrowed enum
      ["changed", "note", false], // required → nullable widens
      ["changed", "email", true], // nullable → required
      ["changed", "price", false],
    ]);
    expect(rows[4].detail).toBe("integer → number");
    expect(rows[5].detail).toBe("enum: paid, refunded, void → paid, refunded");
    expect(rows[8].detail).toBe("maximum: — → 500");
  });

  it("counts and summarizes", () => {
    expect(diffCounts(DIFF)).toEqual({ added: 3, removed: 1, changed: 5, breaking: 5 });
    expect(diffSummary(DIFF)).toBe("3 added · 1 removed · 5 changed");
    expect(diffSummary({ ...DIFF, identical: true })).toBe("No changes");
    expect(flattenDiff(null)).toEqual([]);
  });

  it("formats values and detects breaking attribute changes", () => {
    expect(formatDiffValue(null)).toBe("—");
    expect(formatDiffValue([])).toBe("[]");
    expect(formatDiffValue({ entity: "a", field: "b" })).toBe('{"entity":"a","field":"b"}');
    expect(isBreakingChange("enum", ["a"], null)).toBe(false); // enum removed = widened
    expect(isBreakingChange("enum", ["a", "b"], ["a", "b", "c"])).toBe(false);
    expect(isBreakingChange("pattern", "a", "b")).toBe(false);
  });
});

describe("PSI status mapping", () => {
  it("maps PSI to ok / warn / alert with inclusive thresholds", () => {
    expect(psiStatus(0)).toBe("ok");
    expect(psiStatus(0.0999)).toBe("ok");
    expect(psiStatus(0.1)).toBe("warn");
    expect(psiStatus(0.2499)).toBe("warn");
    expect(psiStatus(0.25)).toBe("alert");
    expect(psiStatus(3)).toBe("alert");
    expect(psiStatus(null)).toBe("unknown");
    expect(psiStatus(Number.NaN)).toBe("unknown");
    expect(psiStatus(0.15, { warn: 0.2, alert: 0.5 })).toBe("ok");
  });

  it("maps server statuses to tones and labels", () => {
    expect(driftTone("ok")).toBe("good");
    expect(driftTone("warn")).toBe("warning");
    expect(driftTone("alert")).toBe("critical");
    expect(driftTone("insufficient_data")).toBe("info");
    expect(driftTone("no_data")).toBe("neutral");
    expect(driftLabel("not_applicable")).toBe("Not applicable");
    expect(driftLabel("something_new")).toBe("something_new");
  });
});

describe("CIDR validation", () => {
  it("accepts IPv4 / IPv6 addresses and ranges", () => {
    for (const v of ["10.0.0.0/8", "192.168.1.10", "0.0.0.0/0", "2001:db8::/32", "::1", "::", "fe80::1", "::ffff:10.0.0.1", "2001:0db8:0000:0000:0000:ff00:0042:8329/128"])
      expect(validateCidr(v), v).toBeNull();
  });

  it("rejects malformed entries", () => {
    for (const v of ["", "10.0.0", "256.1.1.1", "10.0.0.01", "10.0.0.0/33", "10.0.0.0/-1", "10.0.0.0/8/9", "2001:db8::/129", "1:2:3:4:5:6:7:8:9", "2001:::1", "gggg::1", "example.com", "10.0.0.0/"])
      expect(validateCidr(v), v).not.toBeNull();
  });

  it("parses lists with comments, commas and duplicates", () => {
    const r = parseCidrList("10.0.0.0/8 # office\n10.0.0.0/8, 203.0.113.7\n\nbogus");
    expect(r.entries).toEqual(["10.0.0.0/8", "203.0.113.7"]);
    expect(r.errors).toEqual([{ value: "bogus", error: expect.stringContaining("not an IP") }]);
  });

  it("warns about lock-out and catch-all denies", () => {
    expect(policyWarnings({ allow: [], deny: [] })).toEqual([]);
    expect(policyWarnings({ allow: ["10.0.0.0/8"], deny: [] })[0]).toMatch(/lock you out/);
    expect(policyWarnings({ allow: [], deny: ["0.0.0.0/0"] })[0]).toMatch(/catch-all/);
  });
});

describe("inbound hook signature examples", () => {
  it("quotes shell strings safely", () => {
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
  });

  it("computes the same HMAC as the server scheme", async () => {
    const secret = "whsec_test";
    const body = '[{"a":1}]';
    const expected = createHmac("sha256", secret).update(`1700000000.${body}`).digest("hex");
    await expect(computeSignature(secret, 1700000000, body)).resolves.toBe(expected);
    expect(signatureHeaderValue(1700000000, expected)).toBe(`t=1700000000,v1=${expected}`);
  });

  it("builds curl and Python examples without the secret inlined", () => {
    const input = { url: "https://api.example.com/hooks/in/acme/h1", body: `[{"name":"O'Brien"}]`, secretEnv: "HOOK_SECRET" };
    const curl = curlExample(input);
    expect(curl).toContain(`BODY='[{"name":"O'\\''Brien"}]'`);
    expect(curl).toContain(`openssl dgst -sha256 -hmac "$HOOK_SECRET" -hex`);
    expect(curl).toContain(`printf '%s.%s' "$TS" "$BODY"`);
    expect(curl).toContain(`-H "X-AP-Signature: t=$TS,v1=$SIG"`);
    expect(curl).toContain("--data-binary");
    const py = pythonExample({ ...input, contentType: "text/csv" });
    expect(py).toContain('os.environ["HOOK_SECRET"]');
    expect(py).toContain('ts.encode() + b"." + body');
    expect(py).toContain('"Content-Type": "text/csv"');
  });
});

describe("iframe URL validation", () => {
  it("accepts https URLs only", () => {
    const ok = validateIframeUrl(" https://grafana.example.com/d/abc?kiosk ");
    expect(ok).toEqual({ ok: true, url: "https://grafana.example.com/d/abc?kiosk", host: "grafana.example.com", warning: undefined });
    for (const bad of ["http://example.com", "javascript:alert(1)", "data:text/html,<b>x</b>", "ftp://x.com", "not a url", "", "https://user:pw@example.com/"])
      expect(validateIframeUrl(bad).ok, bad).toBe(false);
  });

  it("blocks the app's own origins and warns outside the allowlist", () => {
    expect(validateIframeUrl("https://app.example.com/x", { blockedOrigins: ["https://app.example.com"] }).ok).toBe(false);
    const r = validateIframeUrl("https://evil.test/", { allowlist: ["*.example.com", "docs.google.com"] });
    expect(r.ok && r.warning).toMatch(/not on the organization's allowlisted domains/);
    const allowed = validateIframeUrl("https://bi.example.com/", { allowlist: ["*.example.com"] });
    expect(allowed.ok && allowed.warning).toBeFalsy();
    expect(hostAllowed("example.com", ["*.example.com"])).toBe(false);
    expect(hostAllowed("a.b.example.com", ["*.example.com"])).toBe(true);
  });

  it("wraps custom HTML in a locked-down document with only allow-scripts", () => {
    expect(CUSTOM_HTML_SANDBOX).toBe("allow-scripts");
    const doc = customHtmlSrcdoc("<p>hi</p>");
    expect(doc).toContain("Content-Security-Policy");
    expect(doc).toContain("default-src 'none'");
    expect(doc).toContain("<body><p>hi</p></body>");
  });
});

describe("custom HTML widgets round-trip through the API spec", () => {
  it("maps custom_html ↔ table + config.custom_html", () => {
    const spec: DashboardSpec = {
      pages: [{ id: "p", title: "P", widgets: [{ id: "w", type: "custom_html", title: "C", layout: { x: 0, y: 0, w: 4, h: 4 }, config: { dataset_id: "d", custom_html: { html: "<b>x</b>" } } }] }],
    };
    const api = toApiSpec(spec);
    expect(api.pages[0].widgets[0].type).toBe("table");
    expect(api.pages[0].widgets[0].config.custom_html).toEqual({ html: "<b>x</b>" });
    expect(normalizeSpec(api).pages[0].widgets[0].type).toBe("custom_html");
    expect(fromApiWidget({ ...api.pages[0].widgets[0], config: {} }).type).toBe("table");
  });
});

describe("distribution settings", () => {
  it("parses weights", () => {
    expect(parseWeights("gold=1, silver=3\nbronze = 0.5")).toEqual({ weights: { gold: 1, silver: 3, bronze: 0.5 }, error: null });
    expect(parseWeights("gold").error).toMatch(/value=weight/);
    expect(parseWeights("gold=-1").error).toMatch(/non-negative/);
    expect(parseWeights("a=0,b=0").error).toMatch(/positive/);
  });

  it("builds options.distributions and skips uniform", () => {
    const r = buildDistributions({
      "orders.amount": { kind: "lognormal", mean: "", std: "", sigma: "0.8", weights: "" },
      "orders.qty": { kind: "normal", mean: "5", std: "0", sigma: "", weights: "" },
      "orders.status": { kind: "weights", mean: "", std: "", sigma: "", weights: "paid=9, refunded=1" },
      "orders.id": { kind: "uniform", mean: "", std: "", sigma: "", weights: "" },
    });
    expect(r.distributions).toEqual({
      "orders.amount": { kind: "lognormal", mean: null, sigma: 0.8 },
      "orders.status": { kind: "weights", weights: { paid: 9, refunded: 1 } },
    });
    expect(r.errors).toEqual({ "orders.qty": "Standard deviation must be > 0" });
  });
});
