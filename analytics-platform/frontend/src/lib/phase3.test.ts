import { describe, expect, it } from "vitest";
import { aliasError, aliasMap, suggestAlias, validateAliases } from "./aliases";
import { buildCron, CRON_PRESETS, describeCron, listTimezones, minGapMinutes, parseBuilder, parseCron, validateCron } from "./cron";
import { fourFifthsView, minRatio, parityTone, ratioTone } from "./fairness";
import { activeMention, insertMention, matchUsers, segmentBody } from "./mentions";
import { DEFAULT_DRAFT, draftFromSignature, featuresFromHeader, parseClasses, parseSignatureJson, serializeSignature, type SignatureDraft } from "./onnxSignature";
import { formatPrediction } from "./predictions";
import { buildParams, EMPTY_PARAMS, paramsToForm } from "./schedules";
import { createSseParser, eventJson, parseSse, type SseEvent } from "./sse";
import { wsUrl } from "./api";
import { parseSteps, stepStates } from "./canary";
import { colorScale, projectionOption } from "./projection";
import type { FairnessAttribute } from "./types";

describe("cron helpers", () => {
  it("accepts valid expressions, names, steps and ranges", () => {
    for (const c of ["0 9 * * 1-5", "*/15 * * * *", "30 6 1 jan,jul *", "0 0 * * sun", "0 12 * * 7", "10-50/10 8 * * *"]) expect(validateCron(c)).toBeNull();
    for (const p of CRON_PRESETS) expect(validateCron(p.cron)).toBeNull();
  });

  it("rejects bad syntax with a readable reason", () => {
    expect(validateCron("")).toMatch(/Enter/);
    expect(validateCron("0 9 * *")).toMatch(/5 fields/);
    expect(validateCron("60 9 * * *")).toMatch(/minute value 60 is out of range 0–59/);
    expect(validateCron("0 25 * * *")).toMatch(/hour/);
    expect(validateCron("0 9 * foo *")).toMatch(/invalid value “foo” in month/);
    expect(validateCron("0 9 * * 5-1")).toMatch(/invalid range/);
    expect(validateCron("*/0 * * * *")).toMatch(/invalid step/);
  });

  it("enforces the minimum interval like the server", () => {
    expect(validateCron("* * * * *")).toMatch(/at least 5 minutes/);
    expect(validateCron("*/2 * * * *")).toMatch(/at least 5 minutes/);
    expect(validateCron("0,3 9 * * *")).toMatch(/at least 5 minutes/);
    expect(validateCron("*/5 * * * *")).toBeNull();
    expect(minGapMinutes("0 9 * * *")).toBe(Infinity);
    expect(minGapMinutes("0 */2 * * *")).toBe(120);
  });

  it("normalizes day-of-week 7 to Sunday", () => {
    expect(parseCron("0 0 * * 0,7").values?.[4]).toEqual([0]);
  });

  it("round-trips the builder", () => {
    expect(buildCron({ frequency: "weekdays", minute: 30, hour: 8, weekdays: [], day: 1 })).toBe("30 8 * * 1-5");
    expect(buildCron({ frequency: "weekly", minute: 0, hour: 9, weekdays: [5, 1, 1], day: 1 })).toBe("0 9 * * 1,5");
    expect(buildCron({ frequency: "monthly", minute: 99, hour: -1, weekdays: [], day: 40 })).toBe("59 0 31 * *");
    for (const c of ["15 * * * *", "0 9 * * *", "30 8 * * 1-5", "0 9 * * 1,3", "0 6 15 * *"]) expect(buildCron(parseBuilder(c)!)).toBe(c);
    expect(parseBuilder("*/15 * * * *")).toBeNull();
    expect(parseBuilder("0 9 * 1 *")).toBeNull();
  });

  it("describes schedules in plain language", () => {
    expect(describeCron("0 8 * * 1-5")).toBe("Weekdays at 08:00");
    expect(describeCron("5 14 * * 2,4")).toBe("Every Tuesday, Thursday at 14:05");
    expect(describeCron("*/30 * * * *")).toBe("Every 30 minutes");
    expect(describeCron("0 6 1 * *")).toBe("First of the month at 06:00");
  });

  it("lists UTC first among time zones", () => {
    const tz = listTimezones();
    expect(tz[0]).toBe("UTC");
    expect(tz).toContain("Europe/Berlin");
    expect(new Set(tz).size).toBe(tz.length);
  });
});

describe("dataset aliases", () => {
  it("validates like the server", () => {
    expect(aliasError("orders")).toBeNull();
    expect(aliasError("_t1")).toBeNull();
    expect(aliasError("Orders")).toMatch(/lowercase/);
    expect(aliasError("1orders")).toMatch(/start with a letter/);
    expect(aliasError("my-table")).toMatch(/lowercase/);
    expect(aliasError("select")).toMatch(/SQL keyword/);
    expect(aliasError("a".repeat(41))).toMatch(/40/);
    expect(aliasError("")).toMatch(/Enter/);
  });

  it("suggests valid, unique aliases from names", () => {
    expect(suggestAlias("Customer Orders 2024")).toBe("customer_orders_2024");
    expect(suggestAlias("2024 sales")).toBe("t_2024_sales");
    expect(suggestAlias("Café")).toBe("cafe");
    expect(suggestAlias("order")).toBe("order_t");
    expect(suggestAlias("orders", ["orders", "orders_2"])).toBe("orders_3");
    expect(aliasError(suggestAlias("!!!"))).toBeNull();
  });

  it("checks the whole set: duplicates, datasets and counts", () => {
    const v = validateAliases([
      { alias: "a", datasetId: "ds1" },
      { alias: "a", datasetId: "ds2" },
      { alias: "c", datasetId: "" },
    ]);
    expect(v.valid).toBe(false);
    expect(v.errors).toEqual(["Alias used twice", "Alias used twice", "Choose a dataset"]);
    expect(validateAliases([{ alias: "a", datasetId: "x" }], 2).formError).toMatch(/at least 2/);
    expect(validateAliases(Array.from({ length: 6 }, (_, i) => ({ alias: `t${i}`, datasetId: "x" }))).formError).toMatch(/At most 5/);
    const ok = [
      { alias: "orders", datasetId: "ds1" },
      { alias: "customers", datasetId: "ds2" },
    ];
    expect(validateAliases(ok, 2).valid).toBe(true);
    expect(aliasMap(ok)).toEqual({ orders: "ds1", customers: "ds2" });
  });
});

describe("SSE parser", () => {
  const doc =
    'event: start\ndata: {"endpoint":"e","total":3,"chunk_size":2}\n\n' +
    ": keep-alive comment\n" +
    'event: prediction\ndata: {"offset":0,"count":2}\n\n' +
    "data: line one\ndata: line two\n\n" +
    "event: done\ndata: {\"total\":3}\n\n";

  it("parses events, comments and multi-line data", () => {
    const events = parseSse(doc);
    expect(events.map((e) => e.event)).toEqual(["start", "prediction", "message", "done"]);
    expect(eventJson(events[0])).toEqual({ endpoint: "e", total: 3, chunk_size: 2 });
    expect(events[2].data).toBe("line one\nline two");
    expect(eventJson(events[2])).toBe("line one\nline two");
  });

  it("handles chunks split anywhere, including inside CRLF", () => {
    const crlf = doc.replace(/\n/g, "\r\n");
    for (const size of [1, 2, 3, 7, 64]) {
      const out: SseEvent[] = [];
      const p = createSseParser((e) => out.push(e));
      for (let i = 0; i < crlf.length; i += size) p.push(crlf.slice(i, i + size));
      p.flush();
      expect(out.map((e) => [e.event, e.data])).toEqual(parseSse(doc).map((e) => [e.event, e.data]));
    }
  });

  it("dispatches a trailing event on flush and ignores empty ones", () => {
    expect(parseSse("event: error\ndata: {\"status\":429}")).toEqual([{ event: "error", data: '{"status":429}' }]);
    expect(parseSse("event: ping\n\n")).toEqual([]);
    expect(parseSse("id: 7\ndata:x\n\n")).toEqual([{ event: "message", data: "x", id: "7" }]);
  });
});

describe("websocket URL", () => {
  it("switches the scheme and keeps the base path", () => {
    expect(wsUrl("https://api.example.com", "/v1/endpoints/e/ws?token=t")).toBe("wss://api.example.com/v1/endpoints/e/ws?token=t");
    expect(wsUrl("http://localhost:8000/", "/v1/x")).toBe("ws://localhost:8000/v1/x");
    expect(wsUrl("/api", "/v1/x")).toMatch(/^ws:\/\/localhost(:\d+)?\/api\/v1\/x$/);
  });
});

const attr = (over: Partial<FairnessAttribute>): FairnessAttribute => ({
  attribute: "gender",
  grouping: "categories",
  groups: [
    { group: "a", n: 50, selection_rate: 0.5, base_rate: 0.4, tpr: 0.8, fpr: 0.2, precision: 0.6, accuracy: 0.8, selection_ratio: 1, small_group: false },
    { group: "b", n: 40, selection_rate: 0.3, base_rate: 0.4, tpr: 0.6, fpr: 0.1, precision: 0.7, accuracy: 0.8, selection_ratio: 0.6, small_group: false },
    { group: "c", n: 3, selection_rate: 0, base_rate: 0, tpr: null, fpr: 0, precision: null, accuracy: 1, selection_ratio: 0, small_group: true },
  ],
  demographic_parity_difference: 0.2,
  demographic_parity_ratio: 0.6,
  equalized_odds_difference: 0.2,
  four_fifths_rule: { threshold: 0.8, passed: false, flagged_groups: ["b"] },
  ...over,
});

describe("fairness display", () => {
  it("flags groups below four-fifths with guidance", () => {
    const v = fourFifthsView(attr({}), "approved");
    expect(v.status).toBe("flag");
    expect(v.tone).toBe("warning");
    expect(v.label).toBe("1 group below 80%");
    expect(v.message).toContain("b receives “approved” less than 80%");
    expect(v.message).toContain("lowest ratio 60%");
    expect(v.message).toMatch(/not proof/);
  });

  it("is critical when a group is selected less than half as often as the threshold", () => {
    const a = attr({});
    a.groups[1].selection_ratio = 0.3;
    expect(fourFifthsView(a).tone).toBe("critical");
    expect(minRatio(a)).toBe(0.3); // the small group (0) is ignored
  });

  it("passes and reports insufficient data", () => {
    const pass = fourFifthsView(attr({ four_fifths_rule: { threshold: 0.8, passed: true, flagged_groups: [] } }));
    expect(pass.status).toBe("pass");
    expect(pass.tone).toBe("good");
    const few = attr({ four_fifths_rule: { threshold: 0.8, passed: true, flagged_groups: [] } });
    few.groups = few.groups.slice(0, 1).concat(few.groups[2]);
    expect(fourFifthsView(few).status).toBe("insufficient");
  });

  it("colours ratios and parity differences", () => {
    const g = attr({}).groups;
    expect(ratioTone(g[0])).toBe("good");
    expect(ratioTone(g[1])).toBe("warning");
    expect(ratioTone(g[2])).toBe("neutral");
    expect(parityTone(0.05)).toBe("good");
    expect(parityTone(-0.15)).toBe("warning");
    expect(parityTone(0.4)).toBe("critical");
    expect(parityTone(null)).toBe("neutral");
  });
});

describe("ONNX signature editor", () => {
  const draft: SignatureDraft = {
    ...DEFAULT_DRAFT,
    problem_type: "binary",
    target: "churn",
    classes: "no, yes",
    input: "per_feature",
    features: [
      { name: " tenure ", type: "integer", categories: "", min: "0", max: "72" },
      { name: "plan", type: "string", categories: "basic, pro, , enterprise", min: "5", max: "" },
      { name: "active", type: "boolean", categories: "x", min: "", max: "" },
    ],
    outputs: { label: "label", probabilities: " probs ", value: "" },
  };

  it("serializes to the API shape, dropping fields that don't apply", () => {
    const r = serializeSignature(draft);
    expect(r.errors).toEqual([]);
    expect(r.signature).toEqual({
      problem_type: "binary",
      target: "churn",
      classes: ["no", "yes"],
      input: "per_feature",
      features: [
        { name: "tenure", type: "integer", min: 0, max: 72 },
        { name: "plan", type: "string", categories: ["basic", "pro", "enterprise"] },
        { name: "active", type: "boolean" },
      ],
      outputs: { label: "label", probabilities: "probs" },
    });
  });

  it("round-trips through the editor state", () => {
    const sig = serializeSignature(draft).signature!;
    expect(serializeSignature(draftFromSignature(sig)).signature).toEqual(sig);
    const parsed = parseSignatureJson(JSON.stringify(sig));
    expect(parsed.error).toBeNull();
    expect(serializeSignature(parsed.draft!).signature).toEqual(sig);
  });

  it("validates like the server", () => {
    const dup = serializeSignature({ ...draft, features: [draft.features[0], { ...draft.features[0] }] });
    expect(dup.signature).toBeNull();
    expect(dup.featureErrors).toEqual([null, "Duplicate feature name"]);
    expect(serializeSignature({ ...draft, classes: "a, b, c" }).errors).toContain("Binary models need exactly two classes");
    expect(serializeSignature({ ...draft, problem_type: "multiclass", classes: "a" }).errors[0]).toMatch(/at least two/);
    expect(serializeSignature({ ...draft, problem_type: "multiclass", classes: "a, a" }).errors[0]).toMatch(/unique/);
    expect(serializeSignature({ ...draft, features: [{ ...draft.features[0], min: "9", max: "1" }] }).featureErrors[0]).toMatch(/greater/);
    expect(serializeSignature({ ...draft, features: [{ ...draft.features[0], min: "abc" }] }).featureErrors[0]).toMatch(/numbers/);
    expect(serializeSignature({ ...draft, features: [{ ...draft.features[0], name: "" }] }).featureErrors[0]).toMatch(/required/);
    expect(serializeSignature({ ...draft, features: [] }).errors).toContain("Add at least one feature");
    const reg = serializeSignature({ ...draft, problem_type: "regression", classes: "ignored" }).signature!;
    expect(reg.classes).toBeUndefined();
    expect(parseSignatureJson("[]").error).toMatch(/object/);
    expect(parseSignatureJson("{").error).toBeTruthy();
  });

  it("parses classes and CSV headers", () => {
    expect(parseClasses("0, 1")).toEqual([0, 1]);
    expect(parseClasses("low, 2.5, -1")).toEqual(["low", 2.5, -1]);
    expect(featuresFromHeader('"a", b ,c').map((f) => f.name)).toEqual(["a", "b", "c"]);
  });
});

describe("mentions", () => {
  it("finds the mention being typed", () => {
    expect(activeMention("hi @jo", 6)).toEqual({ start: 3, query: "jo" });
    expect(activeMention("@", 1)).toEqual({ start: 0, query: "" });
    expect(activeMention("mail a@b", 8)).toBeNull();
    expect(activeMention("hi @jo there", 12)).toBeNull();
  });

  it("inserts the user id and moves the caret", () => {
    const text = "ping @jo please";
    const m = activeMention(text, 8)!;
    expect(insertMention(text, m, 8, "usr_1")).toEqual({ text: "ping @usr_1 please", caret: 12 });
  });

  it("matches and renders mentions", () => {
    const users = [
      { id: "usr_1", label: "Ada Lovelace", sub: "ada@x.io" },
      { id: "usr_2", label: "bob@x.io" },
    ];
    expect(matchUsers(users, "ada").map((u) => u.id)).toEqual(["usr_1"]);
    expect(matchUsers(users, "").length).toBe(2);
    expect(segmentBody("hi @usr_1, see a@b and @zz", new Map([["usr_1", "Ada"]]))).toEqual([
      { kind: "text", text: "hi " },
      { kind: "mention", id: "usr_1", label: "Ada" },
      { kind: "text", text: ", see a@b and " },
      { kind: "mention", id: "zz", label: "zz" },
    ]);
  });
});

describe("schedule params", () => {
  it("builds params per job type", () => {
    const f = { ...EMPTY_PARAMS, analytic_id: "an1", values: { region: "EU", min: "5", empty: "" }, recipients: ["u1"], row_limit: "500" };
    expect(buildParams("analytics.scheduled_run", f, [{ name: "min", type: "number", default: 0 }])).toEqual({
      params: { analytic_id: "an1", params: { region: "EU", min: 5 }, row_limit: 500, recipients: ["u1"], chat_destinations: [] },
      error: null,
    });
    expect(buildParams("analytics.scheduled_run", { ...f, row_limit: "20000" }).error).toMatch(/10,000/);
    expect(buildParams("dashboard.deliver", { ...EMPTY_PARAMS, dashboard_id: "d" }).error).toMatch(/recipient/);
    expect(buildParams("dashboard.deliver", { ...EMPTY_PARAMS, dashboard_id: "d", chat_destinations: ["c"], public_link: false }).params).toEqual({
      dashboard_id: "d",
      recipients: [],
      chat_destinations: ["c"],
      public_link: false,
    });
    expect(buildParams("serving.drift_check", { ...EMPTY_PARAMS, hours: "48" }).params).toEqual({ hours: 48 });
    expect(buildParams("serving.drift_check", { ...EMPTY_PARAMS, hours: "0" }).error).toBeTruthy();
    expect(buildParams("serving.canary_step", EMPTY_PARAMS).params).toEqual({});
    expect(buildParams("stream.compact", EMPTY_PARAMS).error).toMatch(/stream/);
    expect(buildParams("pipeline.apply", { ...EMPTY_PARAMS, pipeline_id: "p" }).params).toEqual({ pipeline_id: "p" });
  });

  it("restores the form from saved params", () => {
    const saved = { analytic_id: "an1", params: { min: 5 }, row_limit: 1000, recipients: ["u1"], chat_destinations: [], filters: {} };
    const form = paramsToForm(saved);
    expect(form.values).toEqual({ min: "5" });
    expect(buildParams("analytics.scheduled_run", form, [{ name: "min", type: "number", default: 0 }]).params).toMatchObject({ params: { min: 5 }, recipients: ["u1"] });
  });
});

describe("prediction display", () => {
  it("formats anomaly outputs and plain values", () => {
    expect(formatPrediction({ is_anomaly: true, score: 0.61234 })).toBe("Anomaly (score 0.6123)");
    expect(formatPrediction({ is_anomaly: false, score: 0.1 })).toBe("Normal (score 0.1)");
    expect(formatPrediction("yes")).toBe("yes");
    expect(formatPrediction(null)).toBe("—");
  });
});

describe("canary helpers", () => {
  it("parses and validates traffic steps", () => {
    expect(parseSteps("5, 25, 50, 100")).toEqual({ steps: [5, 25, 50, 100], error: null });
    expect(parseSteps("10 50")).toEqual({ steps: [10, 50, 100], error: null });
    expect(parseSteps("50, 25").error).toMatch(/increasing/);
    expect(parseSteps("0, 50").error).toMatch(/between 1 and 100/);
    expect(parseSteps("5.5").error).toMatch(/whole/);
    expect(parseSteps("").error).toMatch(/at least one/);
  });

  it("derives step states for the timeline", () => {
    expect(stepStates({ steps: [5, 50, 100], step_index: 1, status: "running" })).toEqual(["done", "current", "pending"]);
    expect(stepStates({ steps: [5, 50, 100], step_index: 1, status: "rolled_back" })).toEqual(["done", "failed", "pending"]);
    expect(stepStates({ steps: [5, 100], step_index: 1, status: "completed" })).toEqual(["done", "done"]);
  });
});

describe("projection colours", () => {
  it("picks categorical or continuous scales", () => {
    expect(colorScale(null)).toEqual({ kind: "none" });
    expect(colorScale(["b", "a", null, "b"])).toEqual({ kind: "categorical", categories: ["a", "b", "(missing)"] });
    expect(colorScale([1, 0, 1])).toEqual({ kind: "categorical", categories: ["0", "1"] });
    expect(colorScale(Array.from({ length: 30 }, (_, i) => i / 2))).toEqual({ kind: "continuous", min: 0, max: 14.5 });
    const many = colorScale(Array.from({ length: 20 }, (_, i) => `c${String(i).padStart(2, "0")}`));
    expect(many.kind === "categorical" && many.categories.at(-1)).toBe("(other)");
  });

  it("builds one scatter series per category", () => {
    const opt = projectionOption([0, 1, 2], [0, 1, 2], ["x", "y", "x"], { dark: false, name: "rows" });
    const series = opt.series as { name: string; data: number[][] }[];
    expect(series.map((s) => [s.name, s.data.length])).toEqual([
      ["x", 2],
      ["y", 1],
    ]);
  });
});
