import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { buildConnectorBody, describeConfig, selectQueryError } from "@/lib/connectors";
import { CustomHtmlWidget, IframeWidget } from "./dashboard/EmbedWidgets";
import { chatUrlError } from "./admin/IntegrationTabs";
import { placeholders } from "./admin/PromptsTab";
import { costRows, usd } from "./admin/GovernanceTabs";
import { SchemaDiffView } from "./SchemaDiffView";
import type { CostReport } from "@/lib/types";

describe("custom HTML widget", () => {
  it("renders the HTML only inside a sandboxed srcdoc iframe", () => {
    render(<CustomHtmlWidget html={'<b id="injected">hi</b><script>window.parent.hacked = 1</script>'} title="Custom" columns={["a"]} rows={[{ a: 1 }]} />);
    const frame = screen.getByTitle("Custom") as HTMLIFrameElement;
    expect(frame.tagName).toBe("IFRAME");
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
    expect(frame.getAttribute("sandbox")).not.toContain("allow-same-origin");
    expect(frame.getAttribute("srcdoc")).toContain('<b id="injected">hi</b>');
    // nothing leaks into the app DOM
    expect(document.getElementById("injected")).toBeNull();
  });
});

describe("iframe widget", () => {
  it("embeds https URLs in a sandbox and refuses others", () => {
    const { unmount } = render(<IframeWidget url="https://grafana.example.com/d/1" title="Grafana" />);
    const frame = screen.getByTitle("Grafana");
    expect(frame.getAttribute("src")).toBe("https://grafana.example.com/d/1");
    expect(frame.getAttribute("sandbox")).toContain("allow-scripts");
    expect(frame.getAttribute("referrerpolicy")).toBe("no-referrer");
    unmount();
    render(<IframeWidget url="javascript:alert(1)" title="Bad" />);
    expect(screen.queryByTitle("Bad")).toBeNull();
    expect(screen.getByText(/Only https/)).toBeInTheDocument();
  });
});

describe("schema diff view", () => {
  it("shows the breaking badge and change rows", () => {
    render(
      <SchemaDiffView
        diff={{
          identical: false,
          added_entities: [],
          removed_entities: [],
          entities: [{ name: "orders", added_fields: [{ name: "coupon", type: "string", nullable: true }], removed_fields: [{ name: "legacy", type: "integer", nullable: true }], retyped_fields: [], changed_fields: [] }],
          breaking: true,
          summary: [],
        }}
      />,
    );
    expect(screen.getAllByText("Breaking").length).toBeGreaterThan(0);
    expect(screen.queryByText("Non-breaking")).toBeNull();
    expect(screen.getByText("coupon")).toBeInTheDocument();
    expect(screen.getByText("legacy")).toBeInTheDocument();
    expect(screen.getByText("1 added · 1 removed")).toBeInTheDocument();
  });
});

describe("connector forms", () => {
  it("builds config and write-only credentials, reporting missing fields", () => {
    const r = buildConnectorBody("postgresql", { host: " db.example.com ", port: "5433", database: "sales", username: "ro", password: "" });
    expect(r.config).toEqual({ host: "db.example.com", port: 5433, database: "sales" });
    expect(r.credentials).toEqual({ username: "ro" });
    expect(r.missing).toEqual(["Password"]);
    expect(describeConfig("s3", { bucket: "b", region: "eu-west-1" })).toBe("s3://b (eu-west-1)");
  });

  it("accepts a single SELECT only", () => {
    expect(selectQueryError("SELECT * FROM t;")).toBeNull();
    expect(selectQueryError("-- recent\nWITH x AS (SELECT 1) SELECT * FROM x")).toBeNull();
    expect(selectQueryError("DELETE FROM t")).toMatch(/SELECT/);
    expect(selectQueryError("SELECT 1; DROP TABLE t")).toMatch(/one statement/);
    expect(selectQueryError("  ")).toMatch(/Enter/);
  });
});

describe("admin helpers", () => {
  it("validates chat webhook hosts", () => {
    expect(chatUrlError("slack", "https://hooks.slack.com/services/T/B/x")).toBeNull();
    expect(chatUrlError("slack", "https://evil.example.com/x")).toMatch(/hooks.slack.com/);
    expect(chatUrlError("teams", "https://acme.webhook.office.com/webhookb2/x")).toBeNull();
    expect(chatUrlError("teams", "http://acme.webhook.office.com/x")).toMatch(/https/);
  });

  it("extracts prompt placeholders like the server", () => {
    expect(placeholders("Hi {{ schema }} and {{question}} {{schema}} {{Bad}}")).toEqual(["question", "schema"]);
  });

  it("formats costs and flattens the breakdown", () => {
    expect(usd(0)).toBe("$0.00");
    expect(usd(0.0012)).toBe("$0.0012");
    const report: CostReport = {
      start: "2026-09-01",
      end: "2026-09-27",
      currency: "USD",
      rates: { compute_usd_per_second: 0.001, storage_usd_per_gb_month: 0.02, api_usd_per_1k_requests: 0.5 },
      total_cost_usd: 1.5,
      llm: { cost_usd: 1, by_model: { "claude-x": 1 }, input_tokens: 10, output_tokens: 5, unpriced_requests: 0 },
      compute: { seconds: 200, cost_usd: 0.2, by_job_type: { "training.run": 200 } },
      storage: { bytes: 1024, gb_months: 0.000001, cost_usd: 0, basis: "current usage, prorated" },
      api: { requests: 600, cost_usd: 0.3, by_key: { key1: 600 } },
    };
    const rows = costRows(report);
    expect(rows.map((r) => r.category)).toEqual(["LLM", "Compute", "Storage", "API"]);
    expect(rows[1].cost).toBeCloseTo(0.2);
    expect(rows[3].cost).toBeCloseTo(0.3);
  });
});
