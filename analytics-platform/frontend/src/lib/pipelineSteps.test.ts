import { describe, expect, it } from "vitest";
import { STEP_DEFS, StepValidationError, deserializeStep, describeStep, initialFormState, serializeStep } from "./pipelineSteps";
import type { StepOp } from "./types";

const ALL_OPS: StepOp[] = [
  "drop_missing",
  "fill_missing",
  "handle_outliers",
  "deduplicate",
  "fuzzy_deduplicate",
  "cast",
  "normalize_strings",
  "normalize_dates",
  "rename",
  "drop_columns",
  "reorder",
  "split",
  "merge",
  "derive",
  "filter",
  "mask_pii",
];

describe("pipeline step form serialization", () => {
  it("has a form for every op in the API contract", () => {
    expect(STEP_DEFS.map((d) => d.op).sort()).toEqual([...ALL_OPS].sort());
  });

  it("serializes defaults and omits hidden / empty optional fields", () => {
    expect(serializeStep("drop_missing", initialFormState("drop_missing"))).toEqual({ op: "drop_missing", axis: "rows", how: "any" });
    expect(serializeStep("drop_missing", { ...initialFormState("drop_missing"), axis: "columns" })).toEqual({ op: "drop_missing", axis: "columns", max_null_fraction: 0.5 });
  });

  it("converts numbers, lists, booleans and constants", () => {
    expect(serializeStep("handle_outliers", { ...initialFormState("handle_outliers"), columns: ["price"], threshold: "3", method: "zscore", action: "remove" })).toEqual({
      op: "handle_outliers",
      columns: ["price"],
      method: "zscore",
      threshold: 3,
      action: "remove",
    });
    expect(serializeStep("fill_missing", { ...initialFormState("fill_missing"), strategy: "constant", value: "0" })).toEqual({ op: "fill_missing", strategy: "constant", value: 0 });
    expect(serializeStep("fill_missing", { ...initialFormState("fill_missing"), strategy: "constant", value: "unknown" })).toMatchObject({ value: "unknown" });
    expect(serializeStep("normalize_dates", { ...initialFormState("normalize_dates"), column: "d", formats: ["%d/%m/%Y ", "", " %Y-%m-%d"], dayfirst: true })).toEqual({
      op: "normalize_dates",
      column: "d",
      formats: ["%d/%m/%Y", "%Y-%m-%d"],
      output: "date",
      dayfirst: true,
    });
  });

  it("keeps whitespace separators and maps rename rows to an object", () => {
    expect(serializeStep("merge", { ...initialFormState("merge"), columns: ["first", "last"], into: "full_name" })).toEqual({
      op: "merge",
      columns: ["first", "last"],
      into: "full_name",
      separator: " ",
      drop_original: false,
    });
    expect(serializeStep("rename", { mapping: [{ from: "Old Name", to: "old_name" }, { from: "", to: "" }] })).toEqual({ op: "rename", mapping: { "Old Name": "old_name" } });
  });

  it("serializes the nullable case option to null when unset", () => {
    expect(serializeStep("normalize_strings", initialFormState("normalize_strings"))).toEqual({ op: "normalize_strings", trim: true, case: null, collapse_whitespace: false });
  });

  it("validates required fields and op-specific rules", () => {
    const err = (fn: () => unknown) => {
      try {
        fn();
      } catch (e) {
        return e as StepValidationError;
      }
      throw new Error("expected a validation error");
    };
    expect(err(() => serializeStep("cast", initialFormState("cast"))).errors).toHaveProperty("column");
    expect(err(() => serializeStep("split", { ...initialFormState("split"), column: "a", into: ["only_one"] })).errors).toHaveProperty("into");
    expect(err(() => serializeStep("derive", { name: "bad name", expression: "1" })).errors).toHaveProperty("name");
    expect(err(() => serializeStep("filter", { condition: "   " })).errors).toHaveProperty("condition");
    expect(err(() => serializeStep("drop_missing", { ...initialFormState("drop_missing"), axis: "columns", max_null_fraction: "2" })).errors).toHaveProperty("max_null_fraction");
  });

  it("merges extra fields such as mask_pii semantics", () => {
    expect(serializeStep("mask_pii", { columns: ["email"], strategy: "hash" }, { semantics: { email: "email" } })).toEqual({
      op: "mask_pii",
      columns: ["email"],
      strategy: "hash",
      semantics: { email: "email" },
    });
  });

  it("round-trips through deserializeStep", () => {
    const steps = [
      { op: "cast", column: "amount", to: "number", on_error: "drop_row" },
      { op: "rename", mapping: { a: "b", c: "d" } },
      { op: "split", column: "name", separator: ",", into: ["first", "last"], drop_original: true },
      { op: "derive", name: "total", expression: '"price" * "qty"' },
    ] as const;
    for (const s of steps) {
      expect(serializeStep(s.op, deserializeStep({ ...s }))).toEqual(s);
      expect(describeStep({ ...s })).not.toBe("");
    }
  });
});
