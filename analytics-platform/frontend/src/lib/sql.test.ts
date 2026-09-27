import { describe, expect, it } from "vitest";
import { bindParameters, filterExpr, generateSql, literal, quoteIdent, sqlParameters } from "./sql";

describe("query builder SQL generation", () => {
  it("builds an aggregated query with group by, filters, order and limit", () => {
    const sql = generateSql({
      dimensions: ["region"],
      measures: [
        { column: "amount", aggregation: "sum" },
        { column: "*", aggregation: "count" },
      ],
      filters: [
        { column: "status", op: "=", value: "paid" },
        { column: "amount", op: ">", value: "10" },
      ],
      orderBy: { column: "sum_amount", direction: "desc" },
      limit: 50,
    });
    expect(sql).toBe(
      [
        'SELECT "region", SUM("amount") AS "sum_amount", COUNT(*) AS "count"',
        'FROM "data"',
        `WHERE "status" = 'paid'`,
        '  AND "amount" > 10',
        'GROUP BY "region"',
        'ORDER BY "sum_amount" DESC',
        "LIMIT 50",
      ].join("\n"),
    );
  });

  it("selects raw columns without GROUP BY when nothing is aggregated", () => {
    expect(generateSql({ dimensions: ["a"], measures: [{ column: "b", aggregation: "none" }], filters: [], limit: 10 })).toBe('SELECT "a", "b"\nFROM "data"\nLIMIT 10');
  });

  it("falls back to SELECT * with no columns", () => {
    expect(generateSql({ dimensions: [], measures: [], filters: [] })).toBe('SELECT *\nFROM "data"');
  });

  it("orders by the dimensions by default when aggregating", () => {
    expect(generateSql({ dimensions: ["d"], measures: [{ column: "x", aggregation: "count_distinct" }], filters: [] })).toBe(
      'SELECT "d", COUNT(DISTINCT "x") AS "count_distinct_x"\nFROM "data"\nGROUP BY "d"\nORDER BY "d"',
    );
  });

  it("escapes identifiers and string literals (no injection)", () => {
    expect(quoteIdent('we"ird')).toBe('"we""ird"');
    expect(literal("O'Brien")).toBe("'O''Brien'");
    expect(literal("1; DROP TABLE data")).toBe("'1; DROP TABLE data'");
    expect(literal("-3.5")).toBe("-3.5");
    expect(literal(":start")).toBe(":start");
  });

  it("supports every filter operator", () => {
    expect(filterExpr({ column: "c", op: "is_null" })).toBe('"c" IS NULL');
    expect(filterExpr({ column: "c", op: "not_null" })).toBe('"c" IS NOT NULL');
    expect(filterExpr({ column: "c", op: "contains", value: "ab" })).toBe(`CAST("c" AS VARCHAR) ILIKE '%ab%'`);
    expect(filterExpr({ column: "c", op: "in", value: "US, DE,1" })).toBe(`"c" IN ('US', 'DE', 1)`);
    expect(filterExpr({ column: "c", op: "in", value: "" })).toBe("FALSE");
    expect(filterExpr({ column: "d", op: "between", value: "2024-01-01", value2: ":end" })).toBe(`"d" BETWEEN '2024-01-01' AND :end`);
    expect(filterExpr({ column: "c", op: "!=", value: "x" })).toBe(`"c" != 'x'`);
  });
});

describe("parameters", () => {
  it("finds :params but ignores casts and string literals", () => {
    expect(sqlParameters("SELECT x::int FROM data WHERE d >= :start AND s = ':not_a_param' AND r IN (:region)")).toEqual(["start", "region"]);
  });

  it("binds parameter values as literals for previews", () => {
    expect(bindParameters("SELECT * FROM data WHERE a > :min AND b = :name AND c = :missing", { min: 5, name: "x'y" })).toBe(
      "SELECT * FROM data WHERE a > 5 AND b = 'x''y' AND c = :missing",
    );
    expect(bindParameters("WHERE a = :v", { v: "" })).toBe("WHERE a = NULL");
  });
});
